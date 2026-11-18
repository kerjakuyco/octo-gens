import { type FormEvent, useState } from "react";
import type { VenueView } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { setCredentials, useApp } from "../../state/app";

function CredentialsForm({ venue, onClose }: { venue: VenueView; onClose: () => void }) {
  const busy = useApp((state) => Boolean(state.working));
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [remember, setRemember] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    const ok = await setCredentials({
      venue: venue.id,
      key: key.trim(),
      secret: secret.trim(),
      passphrase: venue.id === "okx" ? passphrase.trim() : undefined,
      remember,
    });
    if (ok) onClose();
  }

  return (
    <form className="form-grid" onSubmit={(event) => void save(event)} autoComplete="off">
      <label className="field">
        <span className="field-label">API key</span>
        <input
          className="input input-code"
          autoComplete="off"
          spellCheck={false}
          data-autofocus
          required
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">API secret</span>
        <input
          className="input input-code"
          type="password"
          autoComplete="off"
          required
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
      </label>
      {venue.id === "okx" ? (
        <label className="field">
          <span className="field-label">API passphrase</span>
          <input
            className="input input-code"
            type="password"
            autoComplete="off"
            required
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
          <span className="field-help">The passphrase you chose when creating the key on OKX.</span>
        </label>
      ) : null}
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        <span>
          Remember in the system keychain
          <span className="field-help">
            Left off, the keys are forgotten when you quit Octo Gens.
          </span>
        </span>
      </label>
      <div className="dialog-actions">
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !key.trim() || !secret.trim()}>
          Save keys
        </button>
      </div>
    </form>
  );
}

export function CredentialsDialog({ venue, onClose }: { venue: VenueView | null; onClose: () => void }) {
  return (
    <Dialog
      open={venue !== null}
      onClose={onClose}
      title={venue ? `${venue.name} API keys` : "API keys"}
      lead={
        venue
          ? `Keys unlock balances and live tickets. They stay on this computer and are sent only to ${venue.name}. Create a key with trading enabled and withdrawals disabled.`
          : undefined
      }
    >
      {venue ? <CredentialsForm venue={venue} onClose={onClose} /> : null}
    </Dialog>
  );
}
