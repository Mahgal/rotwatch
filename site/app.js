(function () {
  "use strict";

  var form = document.getElementById("check-form");
  var input = document.getElementById("url");
  var button = form.querySelector("button[type=submit]");
  var result = document.getElementById("result");

  function el(tag, text) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function showError(message) {
    result.innerHTML = "";
    var card = el("div");
    card.className = "card";
    var p = el("p", message);
    p.className = "error";
    card.appendChild(p);
    result.appendChild(card);
  }

  function renderLinkList(links) {
    var list = el("ul");
    links.forEach(function (link) {
      var item = el("li");
      var status = link.status === null || link.status === undefined
        ? "no response"
        : "HTTP " + link.status;
      var text = link.url + "  (" + status + ")";
      if (link.error) text += "  " + link.error;
      item.textContent = text;
      list.appendChild(item);
    });
    return list;
  }

  function render(data) {
    result.innerHTML = "";
    var card = el("div");
    card.className = "card";

    var head = el("p");
    if (data.ok) {
      head.textContent = "The page answered with HTTP " + data.status +
        " in " + data.responseTimeMs + " ms.";
      head.className = "good";
    } else if (data.status) {
      head.textContent = "The page answered with HTTP " + data.status +
        " in " + data.responseTimeMs + " ms.";
      head.className = "error";
    } else {
      head.textContent = "The page could not be fetched. " + (data.error || "");
      head.className = "error";
    }
    card.appendChild(head);

    var finalUrl = el("p", "Final address: " + (data.finalUrl || data.checkedUrl));
    card.appendChild(finalUrl);

    if (data.ok || data.status) {
      var counts = el("p", "Links found: " + data.linksFound +
        ". Links checked: " + data.linksChecked +
        ". Broken links: " + data.brokenLinks.length + ".");
      card.appendChild(counts);

      if (data.brokenLinks.length > 0) {
        card.appendChild(el("p", "Broken links:"));
        card.appendChild(renderLinkList(data.brokenLinks));
      } else if (data.linksChecked > 0) {
        card.appendChild(el("p", "No broken links found on this page."));
      }

      if (data.links && data.links.length > 0) {
        var details = el("details");
        details.appendChild(el("summary", "All checked links"));
        details.appendChild(renderLinkList(data.links));
        card.appendChild(details);
      }
    }

    result.appendChild(card);
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var raw = input.value.trim();
    if (!raw) {
      showError("Paste a page address first.");
      return;
    }
    var parsed;
    try {
      parsed = new URL(raw);
    } catch (e) {
      showError("That address does not look like a URL. Include https:// at the start.");
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      showError("Only http:// and https:// addresses can be checked.");
      return;
    }

    button.disabled = true;
    button.textContent = "Checking...";
    result.innerHTML = "";
    result.appendChild(el("p", "Checking the page. This can take up to about 30 seconds when a page holds many links."));

    fetch("https://check.khaan.si/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: parsed.toString() })
    }).then(function (response) {
      return response.json().then(function (data) {
        return { status: response.status, data: data };
      });
    }).then(function (pair) {
      if (pair.status >= 400) {
        showError(pair.data && pair.data.error
          ? pair.data.error
          : "The checker refused the request.");
        return;
      }
      render(pair.data);
    }).catch(function () {
      showError("The checker did not answer. Try again in a minute.");
    }).finally(function () {
      button.disabled = false;
      button.textContent = "Check this page";
    });
  });
})();
