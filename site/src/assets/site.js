// The site's one script: the menu on narrow screens, keyboard access to wide tables, the page
// index, and the preview of the assistant on the home page. Every page works without it.
(() => {
  "use strict";

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* ------------------------------------------------------------------ menu */

  // The button comes right before the links in the page, so Tab goes from it into the open menu.
  const menuButton = document.querySelector(".menu-button");
  const nav = document.getElementById("site-nav");
  if (menuButton && nav) {
    const isOpen = () => menuButton.getAttribute("aria-expanded") === "true";
    const setOpen = (open) => {
      menuButton.setAttribute("aria-expanded", String(open));
      nav.toggleAttribute("data-open", open);
    };
    menuButton.addEventListener("click", () => setOpen(!isOpen()));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && isOpen()) {
        setOpen(false);
        menuButton.focus();
      }
    });
    document.addEventListener("click", (event) => {
      if (isOpen() && !nav.contains(event.target) && !menuButton.contains(event.target)) setOpen(false);
    });
    // The width at which site.css folds the links into the menu.
    window.matchMedia("(min-width: 1000px)").addEventListener("change", (event) => {
      if (event.matches) setOpen(false);
    });
  }

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

  /* --------------------------------------------------------------- preview */

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
  // Watches for the preview to come into view before the first conversation plays.
  let watcher = null;
  const stopWaiting = () => {
    watcher?.disconnect();
    watcher = null;
  };

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
    };
  }

  function setComposer(text) {
    composerText.textContent = text || "Ask anything";
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
    resetTicket(p.ticket);
    setComposer("");
    panel.scrollTop = 0;
  }

  /**
   * The first frame of the first conversation: the question sent and the first reading drawn, so
   * the preview never opens on an empty window.
   */
  function prime(panel) {
    clear(panel);
    const p = parts(panel);
    p.said.hidden = false;
    p.activity.hidden = false;
    p.text.setAttribute("data-running", "");
    p.text.textContent = p.phases[1] ?? p.phases[0];
    for (const node of p.timed) node.hidden = Number(node.dataset.at) > 0;
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

  /**
   * Plays a conversation the way the app shows one: typed, sent, read, answered. A primed one
   * starts from its first frame, with the question sent and the first reading drawn.
   */
  async function play(panel, { primed = false } = {}) {
    if (reduced.matches) {
      finish(panel);
      return;
    }
    run += 1;
    const id = run;
    playing = true;
    follow = true;
    setControl("Show answer");
    if (!primed) clear(panel);
    panel.setAttribute("aria-busy", "true");
    const p = parts(panel);
    try {
      let first = 0;
      if (primed) {
        first = 1;
        await after(450, id);
      } else {
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
      }
      for (const [index, phase] of p.phases.entries()) {
        if (index < first) continue;
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

      playing = false;
      panel.removeAttribute("aria-busy");
      setControl("Replay");
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
    }
  }

  function select(index, { focus = false } = {}) {
    stopWaiting();
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
    stopWaiting();
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

  // The first conversation opens on its first frame and plays on once the preview is in view.
  const first = panels[0];
  if (reduced.matches) {
    finish(first);
  } else {
    prime(first);
    // Waiting to play counts as playing: Show answer shows the conversation finished.
    playing = true;
    setControl("Show answer");
    if ("IntersectionObserver" in window) {
      watcher = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          stopWaiting();
          play(first, { primed: true });
        },
        { threshold: 0.25 },
      );
      watcher.observe(demo);
    } else {
      play(first, { primed: true });
    }
  }
  demo.setAttribute("data-ready", "");
})();
