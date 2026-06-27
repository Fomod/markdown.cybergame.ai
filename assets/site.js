(function () {
  var installBar = document.querySelector(".install-bar");
  if (installBar) {
    var updateInstallBar = function () {
      installBar.setAttribute("data-visible", window.scrollY > 260 ? "true" : "false");
    };
    updateInstallBar();
    window.addEventListener("scroll", updateInstallBar, { passive: true });
  }

  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!isIOS) return;

  var appRoot = document.querySelector("[data-app-store-open-state]");
  var statusRegion = document.querySelector("[data-app-store-status]");
  var setStoreState = function (state) {
    if (appRoot) appRoot.setAttribute("data-app-store-open-state", state);
    if (!statusRegion) return;
    var text = statusRegion.getAttribute("data-status-" + state) || statusRegion.getAttribute("data-status-ready") || "";
    if (text) statusRegion.textContent = text;
  };

  var primaryLink = document.querySelector("[data-primary-app-store-link]");
  var autoOpenMarker = document.querySelector('[data-auto-open-app-store="ios-session-once"]');
  var autoOpenKey = appRoot ? appRoot.getAttribute("data-auto-open-key") : "";
  var openAppStore = function (link) {
    if (!link) return;
    var iosUrl = link.getAttribute("data-ios-app-url");
    var webUrl = link.href;
    if (!iosUrl || !webUrl) return;
    var leftPage = false;
    setStoreState("opening");
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) leftPage = true;
      if (document.hidden) setStoreState("native-opened");
    }, { once: true });
    window.location.href = iosUrl;
    window.setTimeout(function () {
      if (!leftPage) {
        setStoreState("fallback");
        window.location.href = webUrl;
      }
    }, 900);
  };

  document.querySelectorAll("[data-ios-app-url]").forEach(function (link) {
    link.addEventListener("click", function (event) {
      event.preventDefault();
      openAppStore(link);
    });
  });

  if (primaryLink && autoOpenMarker && autoOpenKey && window.location.hash !== "#no-auto-store" && !/(?:^|[?&])no_auto_store=1(?:&|$)/.test(window.location.search)) {
    try {
      if (!sessionStorage.getItem(autoOpenKey)) {
        sessionStorage.setItem(autoOpenKey, "1");
        window.setTimeout(function () {
          openAppStore(primaryLink);
        }, 850);
      }
    } catch (error) {
    }
  }
})();
