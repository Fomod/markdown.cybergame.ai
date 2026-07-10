(function () {
  var installBar = document.querySelector(".install-bar");
  if (installBar) {
    var updateInstallBar = function () {
      installBar.setAttribute("data-visible", window.scrollY > 260 ? "true" : "false");
    };
    updateInstallBar();
    window.addEventListener("scroll", updateInstallBar, { passive: true });
  }

  var setupSiteSearch = function () {
    var root = document.querySelector("[data-site-search]");
    if (!root) return;
    var input = root.querySelector("[data-search-input]");
    var form = root.querySelector("[data-search-form]");
    var results = root.querySelector("[data-search-results]");
    var endpoint = root.getAttribute("data-search-endpoint");
    var locale = root.getAttribute("data-search-locale") || "";
    if (!input || !form || !results || !endpoint) return;

    var emptyText = root.getAttribute("data-search-empty") || "No matching answer yet.";
    var resultsLabel = root.getAttribute("data-search-results-label") || "{count} answers";
    var openLabel = root.getAttribute("data-search-open-label") || "Open page";
    var storeLabel = root.getAttribute("data-search-store-label") || "App Store";
    var entries = [];
    var searchDefaults = {};
    var loaded = false;

    var normalize = function (value) {
      var text = String(value || "").toLowerCase();
      try {
        text = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
      } catch (error) {
      }
      return text.replace(/\s+/g, " ").trim();
    };

    var entryText = function (entry) {
      var fileExtensions = entry.fileExtensions || searchDefaults.fileExtensions || [];
      var supportedFormats = entry.supportedFormats || searchDefaults.supportedFormats || "";
      return normalize([
        entry.userQuestion,
        entry.title,
        entry.shortAnswer,
        entry.intent,
        entry.source,
        (entry.promptVariants || []).join(" "),
        fileExtensions.join(" "),
        supportedFormats
      ].join(" "));
    };

    var scoreEntry = function (entry, query) {
      if (!query) return Number(entry.priority || 0) / 1000;
      var haystack = entryText(entry);
      var score = haystack.indexOf(query) >= 0 ? 1000 : 0;
      query.split(" ").forEach(function (part) {
        if (part.length > 1 && haystack.indexOf(part) >= 0) score += 12;
      });
      return score + Number(entry.priority || 0) / 1000;
    };

    var appendText = function (node, text) {
      node.appendChild(document.createTextNode(String(text || "")));
    };

    var deriveSearchCanonicalUrl = function (data, entry) {
      if (entry.canonicalUrl) return entry.canonicalUrl;
      var site = String(data.site || "").replace(/\/$/, "");
      if (!site) return "";
      var prefix = entry.locale && entry.locale !== "en" ? "/" + entry.locale : "";
      if (entry.pageType === "guide") return site + prefix + "/" + (data.guideSlug || "") + "/";
      if (entry.pageType === "articles") return site + prefix + "/articles/";
      if (entry.pageType === "support") return site + prefix + "/privacy-support/";
      if (entry.pageType === "screenshots") return site + prefix + "/screenshots/";
      if (entry.pageType === "search") return site + prefix + "/search/";
      if (entry.pageType === "topic") {
        var topicSlugs = data.topicSlugs || {};
        var topicSlug = topicSlugs[entry.topicKey] || entry.topicKey || "";
        return site + prefix + "/topics/" + topicSlug + "/";
      }
      if (entry.pageType === "article") return site + prefix + "/articles/" + (entry.articleSlug || "") + "/";
      return site + prefix + "/";
    };

    var deriveSearchCampaignToken = function (data, entry) {
      if (entry.conversionMapToken) return entry.conversionMapToken;
      var productCode = data.entryConversionProductCode || (String(data.site || "").indexOf("markdown.") >= 0 ? "md" : "html");
      var localeCode = String(entry.locale || "").replace(/[^a-z0-9]+/g, "");
      var pageToken = entry.pageToken || "";
      var surfaceCode = data.entryConversionSurfaceCode || "search";
      if (!productCode || !localeCode || !pageToken || !surfaceCode) return "";
      var fixedLength = productCode.length + localeCode.length + surfaceCode.length + 3;
      var pageBudget = Math.max(1, 30 - fixedLength);
      var safePageToken = String(pageToken).toLowerCase().replace(/[^a-z0-9_]+/g, "") || "x";
      if (safePageToken.length > pageBudget) {
        var hash = 0;
        for (var hashIndex = 0; hashIndex < safePageToken.length; hashIndex += 1) {
          hash = ((hash << 5) - hash + safePageToken.charCodeAt(hashIndex)) | 0;
        }
        var suffix = Math.abs(hash).toString(16).slice(0, 4).padStart(4, "0");
        safePageToken = pageBudget <= 5 ? safePageToken.slice(0, pageBudget) : safePageToken.slice(0, pageBudget - 5) + "_" + suffix;
      }
      return productCode + "_" + localeCode + "_" + safePageToken + "_" + surfaceCode;
    };

    var decodeCompactSearchEntries = function (data) {
      var rawEntries = Array.isArray(data.entries) ? data.entries : [];
      var fields = Array.isArray(data.fields) ? data.fields : [];
      if (!fields.length || !rawEntries.length || !Array.isArray(rawEntries[0])) return rawEntries;
      var strings = Array.isArray(data.strings) ? data.strings : [];
      var stringFields = {};
      var arrayStringFields = {};
      (Array.isArray(data.stringDictionaryFields) ? data.stringDictionaryFields : []).forEach(function (field) {
        stringFields[field] = true;
      });
      (Array.isArray(data.arrayStringDictionaryFields) ? data.arrayStringDictionaryFields : []).forEach(function (field) {
        arrayStringFields[field] = true;
      });
      var stringValue = function (id) {
        return Number.isInteger(id) && id >= 0 && id < strings.length ? strings[id] : "";
      };
      return rawEntries.map(function (row) {
        var entry = {};
        fields.forEach(function (field, index) {
          var value = row[index];
          if (arrayStringFields[field]) {
            entry[field] = Array.isArray(value) ? value.map(stringValue) : [];
          } else if (stringFields[field]) {
            entry[field] = value === null || value === undefined ? null : stringValue(value);
          } else {
            entry[field] = value;
          }
        });
        entry.canonicalUrl = deriveSearchCanonicalUrl(data, entry);
        entry.conversionMapToken = deriveSearchCampaignToken(data, entry);
        return entry;
      });
    };

    var render = function (rawQuery) {
      var query = normalize(rawQuery);
      results.textContent = "";
      if (!loaded) {
        var loading = document.createElement("p");
        loading.className = "search-empty";
        appendText(loading, emptyText);
        results.appendChild(loading);
        return;
      }

      var localeEntries = entries.filter(function (entry) {
        return !locale || entry.locale === locale;
      });
      var pool = localeEntries.length ? localeEntries : entries;
      var ranked = pool
        .map(function (entry) {
          return { entry: entry, score: scoreEntry(entry, query) };
        })
        .filter(function (item) {
          return query ? item.score > 0 : true;
        })
        .sort(function (a, b) {
          return b.score - a.score || String(a.entry.canonicalUrl || "").localeCompare(String(b.entry.canonicalUrl || ""));
        })
        .slice(0, 8)
        .map(function (item) {
          return item.entry;
        });

      if (!ranked.length) {
        var empty = document.createElement("p");
        empty.className = "search-empty";
        appendText(empty, emptyText);
        results.appendChild(empty);
        return;
      }

      var count = document.createElement("p");
      count.className = "search-count";
      appendText(count, resultsLabel.replace("{count}", String(ranked.length)));
      results.appendChild(count);

      ranked.forEach(function (entry) {
        var article = document.createElement("article");
        article.className = "search-result";
        article.setAttribute("data-search-result", "true");

        var title = document.createElement("h3");
        var titleLink = document.createElement("a");
        titleLink.href = entry.canonicalUrl || "#";
        appendText(titleLink, entry.title || entry.userQuestion || entry.canonicalUrl);
        title.appendChild(titleLink);
        article.appendChild(title);

        var answer = document.createElement("p");
        appendText(answer, entry.shortAnswer || entry.userQuestion || "");
        article.appendChild(answer);

        var meta = document.createElement("p");
        meta.className = "search-meta";
        appendText(meta, [entry.intent, entry.supportedFormats || searchDefaults.supportedFormats].filter(Boolean).join(" · "));
        article.appendChild(meta);

        var actions = document.createElement("div");
        actions.className = "search-result-actions";
        var open = document.createElement("a");
        open.href = entry.canonicalUrl || "#";
        appendText(open, openLabel);
        actions.appendChild(open);
        var appStoreUrl = entry.appStoreUrl || searchDefaults.appStoreUrl || "";
        if (appStoreUrl) {
          var store = document.createElement("a");
          store.className = "button";
          store.href = appStoreUrl;
          store.setAttribute("data-ios-app-url", entry.iosAppUrl || searchDefaults.iosAppUrl || "");
          store.setAttribute("data-app-store-conversion-link", "true");
          store.setAttribute("data-app-store-campaign-ready", "true");
          store.setAttribute("data-app-store-campaign-params-active", (entry.storeUrlIncludesCampaignParams ?? searchDefaults.storeUrlIncludesCampaignParams) ? "true" : "false");
          store.setAttribute("data-conversion-surface", entry.conversionMapSurface || "site-search-result");
          if (entry.conversionMapToken) store.setAttribute("data-app-store-campaign-token", entry.conversionMapToken);
          if (entry.appStoreId || searchDefaults.appStoreId) store.setAttribute("data-app-store-id", entry.appStoreId || searchDefaults.appStoreId);
          appendText(store, storeLabel);
          actions.appendChild(store);
        }
        article.appendChild(actions);
        results.appendChild(article);
      });
    };

    var setQueryUrl = function () {
      try {
        var url = new URL(window.location.href);
        var value = input.value.trim();
        if (value) url.searchParams.set("q", value);
        else url.searchParams.delete("q");
        window.history.replaceState(null, "", url.toString());
      } catch (error) {
      }
    };

    try {
      var initialQuery = new URLSearchParams(window.location.search).get("q");
      if (initialQuery) input.value = initialQuery;
    } catch (error) {
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      setQueryUrl();
      render(input.value);
    });

    input.addEventListener("input", function () {
      render(input.value);
    });

    fetch(endpoint, { credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) throw new Error("search endpoint unavailable");
        return response.json();
      })
      .then(function (data) {
        entries = decodeCompactSearchEntries(data);
        searchDefaults = {
          appStoreUrl: data.appStoreUrl || "",
          iosAppUrl: data.iosAppUrl || "",
          appStoreId: data.appStoreId || "",
          supportedFormats: data.supportedFormats || "",
          fileExtensions: Array.isArray(data.fileExtensions) ? data.fileExtensions : [],
          storeUrlIncludesCampaignParams: Boolean(data.storeUrlIncludesCampaignParams)
        };
        loaded = true;
        render(input.value);
      })
      .catch(function () {
        loaded = true;
        render(input.value);
      });
  };

  setupSiteSearch();

  var userAgent = navigator.userAgent || "";
  var isIOS = /iPad|iPhone|iPod/.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!isIOS) return;

  var appRoot = document.querySelector("[data-app-store-open-state]");
  var statusRegion = document.querySelector("[data-app-store-status]");
  var setStoreState = function (state) {
    if (appRoot) appRoot.setAttribute("data-app-store-open-state", state);
    if (!statusRegion) return;
    var text = statusRegion.getAttribute("data-status-" + state) || statusRegion.getAttribute("data-status-ready") || "";
    if (text) statusRegion.textContent = text;
  };

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

  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest("[data-ios-app-url]") : null;
    if (!link) return;
    event.preventDefault();
    openAppStore(link);
  });
})();
