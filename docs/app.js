(() => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  requestAnimationFrame(() => document.body.classList.add("loaded"));

  // Scroll progress.
  const bar = $("#progress-bar");
  const progress = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = `${max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 0}%`;
  };
  progress();
  window.addEventListener("scroll", progress, { passive: true });
  window.addEventListener("resize", progress);

  // Reveal on scroll, with a small stagger inside each grid.
  const items = $$(".reveal");
  items.forEach((el) => {
    const siblings = el.parentElement ? [...el.parentElement.children].filter((node) => node.classList.contains("reveal")) : [];
    const index = Math.max(0, siblings.indexOf(el));
    el.style.transitionDelay = `${Math.min(index * 70, 420)}ms`;
  });

  if (reduced || !("IntersectionObserver" in window)) {
    items.forEach((el) => el.classList.add("in"));
  } else {
    const inView = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.top < window.innerHeight * 0.94 && rect.bottom > 0;
    };
    // The hero is above the fold: never wait on an observer callback to show it.
    items.forEach((el) => { if (inView(el)) el.classList.add("in"); });
    window.setTimeout(() => items.forEach((el) => { if (inView(el)) el.classList.add("in"); }), 250);
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      }
    }, { rootMargin: "0px 0px -10% 0px", threshold: 0.12 });
    items.forEach((el) => { if (!el.classList.contains("in")) io.observe(el); });
  }

  // Counters.
  const counters = $$("[data-count]");
  const runCounter = (el) => {
    const target = Number(el.dataset.count) || 0;
    if (reduced) { el.textContent = String(target); return; }
    const start = performance.now();
    const duration = 1100;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(target * eased));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  if (!("IntersectionObserver" in window)) {
    counters.forEach(runCounter);
  } else {
    const counterObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          runCounter(entry.target);
          counterObserver.unobserve(entry.target);
        }
      }
    }, { threshold: 0.6 });
    counters.forEach((el) => counterObserver.observe(el));
  }

  // Hero tilt: subtle, pointer-only.
  const stage = $("#hero-stage");
  const device = $("#device");
  if (stage && device && !reduced && window.matchMedia("(pointer: fine)").matches) {
    let frame = 0;
    let rx = 2;
    let ry = 0;
    const apply = () => {
      frame = 0;
      device.style.setProperty("--rx", `${rx.toFixed(2)}deg`);
      device.style.setProperty("--ry", `${ry.toFixed(2)}deg`);
    };
    stage.addEventListener("pointermove", (event) => {
      const rect = stage.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      ry = x * 4.5;
      rx = 2 - y * 3.5;
      if (!frame) frame = requestAnimationFrame(apply);
    });
    stage.addEventListener("pointerleave", () => {
      ry = 0;
      rx = 2;
      if (!frame) frame = requestAnimationFrame(apply);
    });
  }

  // Copy the install block.
  const copy = $("#copy-install");
  if (copy) {
    copy.addEventListener("click", async () => {
      const code = $("#install-code");
      const text = code ? code.textContent.replace(/\u00a0/g, " ") : "";
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "copied";
      } catch {
        copy.textContent = "select + copy";
      }
      window.setTimeout(() => { copy.textContent = "copy"; }, 1800);
    });
  }

  // Pause the ticker while the pointer is on it.
  const ticker = $(".ticker-track");
  if (ticker && !reduced) {
    ticker.addEventListener("pointerenter", () => { ticker.style.animationPlayState = "paused"; });
    ticker.addEventListener("pointerleave", () => { ticker.style.animationPlayState = "running"; });
  }
})();
