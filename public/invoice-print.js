// The invoice page is served with the app's own Content-Security-Policy, which
// allows scripts only from this origin. An inline onclick is blocked outright
// by that policy — which is why the print button did nothing at all — so the
// button is wired up from here instead.
document.addEventListener("click", function (event) {
  var target = event.target.closest("[data-print-invoice]");
  if (!target) return;
  event.preventDefault();
  window.print();
});
