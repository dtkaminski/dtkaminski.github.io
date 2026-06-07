/* Operator Intelligence — lightweight access gate.
   NOTE: this is a deterrent, not real security. The repo is public, so the
   underlying data files remain directly fetchable. This only stops a casual
   visitor from reading the rendered dashboard. For true privacy use a private
   repo on a paid plan, or a host with server-side auth.

   To change the passcode: run in any terminal
     node -e "console.log(require('crypto').createHash('sha256').update('YOUR_NEW_CODE').digest('hex'))"
   and paste the result into PASS_HASH below. */
(function () {
  var PASS_HASH = "b8bd9e7d7fe04b396ddc52df76d65e84a99565fff0f22d805d6b13b4517bcdb5"; // default: frkl2026
  var KEY = "oi_gate_v1";

  function sha256Hex(str) {
    var enc = new TextEncoder().encode(str);
    return crypto.subtle.digest("SHA-256", enc).then(function (buf) {
      return Array.prototype.map
        .call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); })
        .join("");
    });
  }

  // Already unlocked this browser?
  try { if (localStorage.getItem(KEY) === PASS_HASH) return; } catch (e) {}

  function build() {
    var ov = document.createElement("div");
    ov.id = "oi-gate";
    ov.setAttribute("style", [
      "position:fixed", "inset:0", "z-index:2147483647",
      "background:#08080b", "color:#f1f1f4",
      "display:flex", "align-items:center", "justify-content:center",
      "font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif"
    ].join(";"));
    ov.innerHTML =
      '<div style="width:320px;max-width:88vw;text-align:center">' +
        '<div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#7c8cff;margin-bottom:18px">Operator Intelligence</div>' +
        '<div style="font-size:15px;color:#b1b1bc;margin-bottom:18px">Enter the access code to view this workspace.</div>' +
        '<input id="oi-gate-input" type="password" autocomplete="off" placeholder="Access code" ' +
          'style="width:100%;padding:11px 13px;border-radius:8px;border:1px solid #2a2a34;background:#111116;color:#f1f1f4;font-size:14px;outline:none;text-align:center" />' +
        '<button id="oi-gate-btn" style="width:100%;margin-top:10px;padding:11px;border:0;border-radius:8px;background:#7c8cff;color:#fff;font-weight:600;font-size:14px;cursor:pointer">Unlock</button>' +
        '<div id="oi-gate-err" style="height:16px;margin-top:10px;font-size:12px;color:#ff7c7c"></div>' +
      '</div>';
    document.body.appendChild(ov);

    var input = ov.querySelector("#oi-gate-input");
    var btn = ov.querySelector("#oi-gate-btn");
    var err = ov.querySelector("#oi-gate-err");
    input.focus();

    function submit() {
      sha256Hex(input.value || "").then(function (h) {
        if (h === PASS_HASH) {
          try { localStorage.setItem(KEY, PASS_HASH); } catch (e) {}
          ov.remove();
        } else {
          err.textContent = "Incorrect code";
          input.value = "";
          input.focus();
        }
      });
    }
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
  }

  if (document.body) build();
  else document.addEventListener("DOMContentLoaded", build);
})();
