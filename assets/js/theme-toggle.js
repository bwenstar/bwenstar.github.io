/* assets/js/theme-toggle.js
   The theme is applied before first paint by the inline script in _includes/head.html;
   this wires up the button. The icons are swapped by CSS ([data-theme="dark"]), so only
   the label needs updating here. With no saved choice, the page follows the system. */
(() => {
  const KEY = "theme";
  const root = document.documentElement;
  const system = window.matchMedia("(prefers-color-scheme: dark)");

  const saved = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  const isDark = () => root.getAttribute("data-theme") === "dark";

  const apply = (dark) => {
    if (dark) root.setAttribute("data-theme", "dark");
    else root.removeAttribute("data-theme");
    const btn = document.getElementById("theme-toggle");
    if (btn) btn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  };

  apply(saved() ? saved() === "dark" : system.matches);
  system.addEventListener("change", (e) => { if (!saved()) apply(e.matches); });

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    apply(isDark());
    btn.addEventListener("click", () => {
      const next = !isDark();
      apply(next);
      try { localStorage.setItem(KEY, next ? "dark" : "light"); } catch (e) { /* private mode */ }
    });
  });
})();
