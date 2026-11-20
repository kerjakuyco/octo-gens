// The site's one script: the header's menus, keyboard access to wide tables, the page index, and on
// the home page the conversation that plays in once and the preview of the assistant. Every page
// works without it.
(() => {
  "use strict";

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ---------------------------------------------------------------- header */

  const header = document.querySelector("[data-header]");

  // The bar tightens once the page has moved.
  if (header) {
    let pending = false;
    const mark = () => {
      pending = false;
      header.toggleAttribute("data-scrolled", window.scrollY > 8);
    };
    window.addEventListener(
      "scroll",
      () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(mark);
      },
      { passive: true },
    );
    mark();
  }

  // Product: a button that opens a panel of links. Enter, Space or a click toggles it, ArrowDown
  // opens it at its first link, the arrows move between its links, and Escape, a click elsewhere or
  // leaving it with Tab closes it.
  const group = header?.querySelector("[data-nav-group]");
  const trigger = group?.querySelector(".nav-trigger");
  const items = group ? [...group.querySelectorAll(".nav-item")] : [];
  const panelOpen = () => trigger?.getAttribute("aria-expanded") === "true";
  const setPanel = (open) => {
    if (!trigger) return;
    trigger.setAttribute("aria-expanded", String(open));
    group.toggleAttribute("data-open", open);
  };
  if (group && trigger && items.length) {
    trigger.addEventListener("click", () => setPanel(!panelOpen()));
    trigger.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      setPanel(true);
      (event.key === "ArrowDown" ? items[0] : items.at(-1)).focus();
    });
    group.addEventListener("keydown", (event) => {
      // Only keys pressed on a link of the panel; the button's own keys are handled above.
      const at = items.indexOf(event.target);
      if (at < 0) return;
      const last = items.length - 1;
      const next = { ArrowDown: at === last ? 0 : at + 1, ArrowUp: at === 0 ? last : at - 1, Home: 0, End: last }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      items[next].focus();
    });
    group.addEventListener("focusout", (event) => {
      if (panelOpen() && !group.contains(event.relatedTarget)) setPanel(false);
    });
    document.addEventListener("pointerdown", (event) => {
      if (panelOpen() && !group.contains(event.target)) setPanel(false);
    });
  }

  // On a phone, the menu button opens a sheet over the whole page. The button comes right before
  // the links in the page, so Tab goes from it into the sheet; the page under the sheet, and the
  // link that skips to it, are inert.
  const menuButton = header?.querySelector(".menu-button");
  const nav = document.getElementById("site-nav");
  const phone = window.matchMedia("(max-width: 800px)");
  const behind = [document.querySelector(".skip-link"), document.querySelector("main"), document.querySelector(".site-footer")].filter(Boolean);
  const sheetOpen = () => menuButton?.getAttribute("aria-expanded") === "true";
  const setSheet = (open) => {
    if (!menuButton || !nav) return;
    menuButton.setAttribute("aria-expanded", String(open));
    nav.toggleAttribute("data-open", open);
    document.documentElement.toggleAttribute("data-menu-open", open);
    for (const node of behind) node.inert = open;
  };
  if (menuButton && nav) {
    menuButton.addEventListener("click", () => setSheet(!sheetOpen()));
    // A link to a part of the page it is on closes the sheet, so the page can be seen.
    nav.addEventListener("click", (event) => {
      if (event.target.closest("a") && sheetOpen()) setSheet(false);
    });
    phone.addEventListener("change", (event) => {
      if (!event.matches) setSheet(false);
      setPanel(false);
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (panelOpen()) {
      setPanel(false);
      trigger.focus();
    } else if (sheetOpen()) {
      setSheet(false);
      menuButton.focus();
    }
  });

  /* ---------------------------------------------- wide tables and code */

  // A box that scrolls sideways can be scrolled with the keyboard once it can take focus.
  const scrollers = [...document.querySelectorAll(".table-wrap, .code")];
  const label = (node) => {
    const heading = node.closest("section")?.querySelector("h2");
    return node.classList.contains("code") ? "Code" : `Table${heading ? `: ${heading.textContent}` : ""}`;
  };
  const markScrollers = () => {
    for (const node of scrollers) {
      const scrolls = node.scrollWidth > node.clientWidth + 1;
      if (scrolls && !node.hasAttribute("tabindex")) {
        node.tabIndex = 0;
        if (!node.hasAttribute("aria-label")) {
          node.setAttribute("role", "region");
          node.setAttribute("aria-label", label(node));
          node.dataset.labelled = "";
        }
      } else if (!scrolls && node.hasAttribute("tabindex")) {
        node.removeAttribute("tabindex");
        if (node.dataset.labelled !== undefined) {
          node.removeAttribute("role");
          node.removeAttribute("aria-label");
          delete node.dataset.labelled;
        }
      }
    }
  };
  if (scrollers.length) {
    markScrollers();
    let pending = 0;
    const later = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(markScrollers);
    };
    window.addEventListener("resize", later);
    // A table inside a closed disclosure has no width until it is opened. The event does not
    // bubble, so it is caught on its way down.
    document.addEventListener("toggle", later, true);
  }

  /* ------------------------------------------------------------ page index */

  // The index beside a long page marks the section being read.
  const toc = document.querySelector(".toc");
  if (toc && "IntersectionObserver" in window) {
    const links = new Map([...toc.querySelectorAll('a[href^="#"]')].map((a) => [a.getAttribute("href").slice(1), a]));
    const visible = new Set();
    const mark = () => {
      const first = [...links.keys()].find((id) => visible.has(id));
      for (const [id, a] of links) {
        if (id === first) a.setAttribute("aria-current", "location");
        else a.removeAttribute("aria-current");
      }
    };
    const watcher = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        mark();
      },
      { rootMargin: "-10% 0px -55% 0px" },
    );
    for (const id of links.keys()) {
      const target = document.getElementById(id);
      if (target) watcher.observe(target);
    }
  }

  /* ------------------------------------------ the conversation that plays once */

  // The Assistant panel of the home page's grid is the page's one moment of motion: the first time
  // it is in view, its question, reading, plan and answer come in one after another. site.css draws
  // the steps; this only says when. Without the script, or under reduced motion, it is drawn finished.
  const once = document.querySelector("[data-play-once]");
  if (once && !reduced.matches) {
    once.setAttribute("data-armed", "");
    const play = () => once.setAttribute("data-play", "");
    if ("IntersectionObserver" in window) {
      const watch = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          watch.disconnect();
          play();
        },
        { threshold: 0.4 },
      );
      watch.observe(once);
    } else {
      play();
    }
  }

  /* -------------------------------------------------------------- download */

  // The download page is built listing every system's installers: what a crawler, a phone, a tablet
  // or a browser without this script shows. On a computer whose system it can tell, that system's
  // installer comes first as the one card, and the others fold away, closed, under "Other platforms".
  const installers = document.querySelector("[data-installers]");
  if (installers) {
    const system = detectSystem();
    if (system) arrange(installers, system);
    // Only some browsers say a Mac's chip, and only when asked. An Intel Mac cannot run the disk
    // image, so for one the card leads with building from source.
    if (system === "macos" && navigator.userAgentData?.getHighEntropyValues) {
      navigator.userAgentData
        .getHighEntropyValues(["architecture"])
        .then((values) => {
          if (values.architecture === "x86") leadWithSource(installers);
        })
        .catch(() => {});
    }
  }

  /** "windows", "macos" or "linux" for a computer, or null for a phone, a tablet or anything unclear. */
  function detectSystem() {
    const data = navigator.userAgentData;
    const agent = navigator.userAgent || "";
    if (data?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(agent)) return null;
    const named = data?.platform || navigator.platform || "";
    // An iPad asks for the desktop site as a Mac; a Mac with a touch screen is one.
    if (/Mac/i.test(named) && navigator.maxTouchPoints > 1) return null;
    if (/^Win/i.test(named)) return "windows";
    if (/^Mac|macOS/i.test(named)) return "macos";
    if (/Linux/i.test(named)) return "linux";
    if (named) return null;
    if (/Windows/i.test(agent)) return "windows";
    if (/Macintosh|Mac OS X/i.test(agent)) return "macos";
    if (/Linux|X11/i.test(agent)) return "linux";
    return null;
  }

  function arrange(container, system) {
    const cards = [...container.querySelectorAll("[data-platform]")];
    const mine = cards.find((card) => card.dataset.platform === system);
    if (!mine) return;
    const heading = mine.querySelector(".platform-name");
    heading.textContent = `Download for ${heading.textContent}`;
    // The first file stays the button; the system's other files become quiet links beneath it.
    for (const link of [...mine.querySelectorAll(".platform-files a")].slice(1)) link.className = "platform-alt";
    mine.classList.add("platform-mine");
    container.dataset.detected = system;

    const others = document.createElement("details");
    others.className = "platforms-other";
    const summary = document.createElement("summary");
    summary.textContent = "Other platforms";
    const grid = document.createElement("div");
    grid.className = "platforms-other-grid";
    for (const card of cards) if (card !== mine) grid.append(card);
    others.append(summary, grid);
    container.after(others);
  }

  function leadWithSource(container) {
    const mine = container.querySelector('.platform-mine[data-platform="macos"]');
    if (!mine) return;
    const files = mine.querySelector(".platform-files");
    const image = files.querySelector("a");
    const build = document.createElement("a");
    build.className = "button button-brand";
    build.href = "#build";
    build.textContent = "Build from source";
    const item = document.createElement("li");
    item.append(build);
    files.prepend(item);
    image.className = "platform-alt";
    image.textContent = "Disk image for Apple silicon (.dmg)";
    const note = mine.querySelector(".platform-note");
    if (note) mine.querySelector(".platform-detail").after(note);
    mine.dataset.intel = "true";
  }

  /* --------------------------------------------------------------- preview */

  // The preview of the assistant opens on its first conversation, finished. Picking a prompt, or
  // Replay, plays a conversation step by step, as the app shows one; under reduced motion it is
  // shown finished at once.
  const demo = document.querySelector("[data-demo]");
  if (!demo) return;

  class Cancelled extends Error {}

  const tabs = [...demo.querySelectorAll('[role="tab"]')];
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute("aria-controls")));
  const tablist = demo.querySelector('[role="tablist"]');
  const note = demo.querySelector("[data-demo-note]");
  const control = demo.querySelector("[data-demo-replay]");
  const composer = demo.querySelector(".d-composer");
  const composerText = demo.querySelector(".d-composer-text");

  // Each answer as it reads when finished; playing copies it in a few characters at a time.
  const answers = new Map(panels.map((panel) => [panel, panel.querySelector("[data-stream]").cloneNode(true)]));

  let run = 0;
  let playing = false;
  let follow = true;

  const current = () => panels.find((panel) => !panel.hidden) ?? panels[0];
  const after = (ms, id) =>
    new Promise((resolve, reject) => setTimeout(() => (id === run ? resolve() : reject(new Cancelled())), ms));
  const nextFrame = (id) =>
    new Promise((resolve, reject) => requestAnimationFrame(() => (id === run ? resolve() : reject(new Cancelled()))));

  function parts(panel) {
    const activity = panel.querySelector(".d-activity");
    return {
      prompt: panel.querySelector(".d-bubble").textContent,
      said: panel.querySelector(".d-said"),
      activity,
      text: activity.querySelector(".d-activity-text"),
      phases: JSON.parse(activity.dataset.phases),
      timed: [...panel.querySelectorAll("[data-at]")],
      answer: panel.querySelector("[data-stream]"),
      ticket: panel.querySelector(".d-ticket"),
      follow: panel.querySelector("[data-follow]"),
    };
  }

  function setComposer(text) {
    composerText.textContent = text || "Ask anything, or type / for commands";
    composerText.toggleAttribute("data-typing", Boolean(text));
    composer.toggleAttribute("data-ready", Boolean(text));
  }

  function resetTicket(ticket) {
    if (!ticket) return;
    ticket.dataset.state = "pending";
    ticket.querySelector(".d-ticket-actions").hidden = false;
    ticket.querySelector("[data-ticket-note]").hidden = true;
    ticket.querySelector("[data-ticket-dismissed]").hidden = true;
  }

  /**
   * How far down the conversation may scroll: until the last card read sits at the top, the plan
   * for a trade. Past that, the question and the readings would leave the view.
   */
  function stop(panel) {
    const cards = [...panel.querySelectorAll(".d-cards > .d-card")].filter((card) => !card.hidden);
    const end = panel.scrollHeight - panel.clientHeight;
    if (!cards.length) return end;
    const top = cards.at(-1).getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
    return Math.max(0, Math.min(end, top - (parseFloat(getComputedStyle(panel).paddingTop) || 0)));
  }

  function stick(panel) {
    if (follow) panel.scrollTop = stop(panel);
  }

  function setControl(label) {
    control.textContent = label;
  }

  /** The conversation as it reads when finished, with no motion. */
  function finish(panel) {
    run += 1;
    playing = false;
    const p = parts(panel);
    p.said.hidden = false;
    p.activity.hidden = false;
    p.text.textContent = p.text.dataset.summary;
    p.text.removeAttribute("data-running");
    for (const node of p.timed) {
      node.hidden = false;
      node.classList.remove("is-new");
    }
    p.answer.replaceChildren(...answers.get(panel).cloneNode(true).childNodes);
    p.answer.hidden = false;
    if (p.follow) {
      p.follow.hidden = false;
      p.follow.classList.remove("is-new");
    }
    resetTicket(p.ticket);
    setComposer("");
    panel.removeAttribute("aria-busy");
    setControl("Replay");
    panel.scrollTop = stop(panel);
  }

  /** Empties a conversation, ready to play. */
  function clear(panel) {
    const p = parts(panel);
    p.said.hidden = true;
    p.activity.hidden = true;
    p.activity.open = false;
    for (const node of p.timed) node.hidden = true;
    p.answer.replaceChildren();
    p.answer.hidden = true;
    if (p.follow) p.follow.hidden = true;
    resetTicket(p.ticket);
    setComposer("");
    panel.scrollTop = 0;
  }

  function reveal(nodes, panel) {
    for (const node of nodes) {
      node.hidden = false;
      node.classList.add("is-new");
    }
    stick(panel);
  }

  /** Copies the finished answer into place a few characters at a time, keeping its markup. */
  async function stream(from, into, id, panel) {
    for (const node of [...from.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        if (!text.trim()) {
          into.append(text);
          continue;
        }
        const out = document.createTextNode("");
        into.append(out);
        for (let end = 3; end < text.length + 3; end += 3) {
          out.textContent = text.slice(0, end);
          stick(panel);
          await nextFrame(id);
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const copy = node.cloneNode(false);
        into.append(copy);
        await stream(node, copy, id, panel);
      }
    }
  }

  /** Plays a conversation the way the app shows one: typed, sent, read, answered. */
  async function play(panel) {
    if (reduced.matches) {
      finish(panel);
      return;
    }
    run += 1;
    const id = run;
    playing = true;
    follow = true;
    setControl("Show answer");
    clear(panel);
    panel.setAttribute("aria-busy", "true");
    const p = parts(panel);
    try {
      await after(250, id);
      for (let end = 1; end <= p.prompt.length; end += 1) {
        setComposer(p.prompt.slice(0, end));
        await after(18, id);
      }
      await after(280, id);
      setComposer("");
      p.said.hidden = false;
      p.said.classList.add("is-new");
      await after(320, id);

      p.activity.hidden = false;
      p.text.setAttribute("data-running", "");
      p.text.textContent = "Thinking";
      reveal(p.timed.filter((node) => Number(node.dataset.at) < 0), panel);
      await after(520, id);
      for (const [index, phase] of p.phases.entries()) {
        p.text.textContent = phase;
        await after(280, id);
        reveal(p.timed.filter((node) => Number(node.dataset.at) === index), panel);
        await after(160, id);
      }

      // While the answer is written, the line says what was checked.
      p.text.removeAttribute("data-running");
      p.text.textContent = p.text.dataset.summary;
      reveal(p.timed.filter((node) => Number(node.dataset.at) >= p.phases.length), panel);
      p.answer.hidden = false;
      await stream(answers.get(panel), p.answer, id, panel);
      // As in the app, the next steps come once the answer is written.
      if (p.follow) {
        await after(200, id);
        reveal([p.follow], panel);
      }

      playing = false;
      panel.removeAttribute("aria-busy");
      setControl("Replay");
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
    }
  }

  function select(index, { focus = false } = {}) {
    tabs.forEach((tab, i) => {
      const selected = i === index;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[i].hidden = !selected;
    });
    note.innerHTML = panels[index].dataset.note;
    if (focus) tabs[index].focus();
    play(panels[index]);
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(index));
    tab.addEventListener("keydown", (event) => {
      const last = tabs.length - 1;
      const next = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(next, { focus: true });
    });
  });

  control.addEventListener("click", () => {
    if (playing) finish(current());
    else play(current());
  });

  // Scrolling the conversation while it plays stops the view from following new text.
  for (const panel of panels) {
    const hold = () => {
      if (playing) follow = false;
    };
    panel.addEventListener("wheel", hold, { passive: true });
    panel.addEventListener("touchstart", hold, { passive: true });
    panel.addEventListener("keydown", hold);
  }

  // The ticket's buttons answer as the app would, except that nothing is sent anywhere.
  demo.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ticket]");
    if (!button) return;
    const ticket = button.closest(".d-ticket");
    ticket.querySelector(".d-ticket-actions").hidden = true;
    const placed = button.dataset.ticket === "place";
    const shown = ticket.querySelector(placed ? "[data-ticket-note]" : "[data-ticket-dismissed]");
    if (!placed) ticket.dataset.state = "dismissed";
    shown.hidden = false;
    // The note ends the conversation, so the view moves to its end. The button is gone, so focus
    // moves to what replaced it, and a screen reader reads it.
    const panel = ticket.closest(".d-panel");
    panel.scrollTop = panel.scrollHeight;
    shown.tabIndex = -1;
    shown.focus({ preventScroll: true });
  });

  tablist.hidden = false;
  control.hidden = false;

  // The first conversation, finished, scrolled to its plan and ticket.
  finish(panels[0]);
})();
