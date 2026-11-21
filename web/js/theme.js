// Runs before first paint (loaded synchronously in <head>) so the saved theme shows with no flash.
// Own storage key so the choice does not leak between the *.chocorot.net apps.
try { var t = localStorage.getItem("choco-harness-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch (e) { /* storage blocked: follow the system */ }
