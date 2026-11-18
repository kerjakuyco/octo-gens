from pathlib import Path
import os
import sys

from .domain import DeskError, Workspace
from .market import Market
from .paper import PaperBook


def data_directory():
    if override := os.environ.get("OCTOGENS_DATA_DIR"):
        return Path(override)
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "Octo Gens"
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/Octo Gens"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "octo-gens"


class Desk:
    """One workspace. A background job keeps the workspace it was started in."""

    def __init__(self, mode, directory, market=None, broker=None):
        self.mode = mode
        self.market = market or Market()
        if mode.broker != (broker is not None):
            raise DeskError("Connect the matching broker account first.")
        if broker is not None and broker.host != broker.HOSTS[mode]:
            raise DeskError("The broker connection does not match this workspace.")
        self.book = None if mode.broker else PaperBook(directory / "paper.sqlite3", mode)
        self.broker = broker

    def quote(self, asset, *, refresh=False):
        q = self.market.quote(asset, sample=self.mode == Workspace.DEMO, refresh=refresh)
        if self.book:
            self.book.remember(q)
        return q

    def account(self):
        return (self.broker or self.book).snapshot()

    def revalue(self):
        account = self.account()
        missed = []
        if self.mode == Workspace.MARKET and account.holdings:
            for holding in account.holdings:
                try:
                    self.quote(holding.symbol, refresh=True)
                except DeskError:
                    missed.append(holding.symbol)
            account = self.account()
        return account, missed

    def submit(self, ticket):
        if self.broker:
            return self.broker.submit(ticket)
        q = self.market.quote(ticket.symbol, sample=self.mode == Workspace.DEMO, refresh=True)
        return self.book.submit(ticket, q)
