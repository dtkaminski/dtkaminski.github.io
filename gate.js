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
    // The first screen anyone sees, and it was the last one still wearing the old dark
    // theme: near-black canvas, a #7c8cff indigo that is in no palette this product uses,
    // and Inter — which the design rules ban outright. It also failed contrast twice
    // ("Unlock" at 2.98:1, the hint text at 1.89:1). Same tokens as the product now, with
    // a var() fallback on each because gate.js is deliberately the first script on the
    // page and must still render if the stylesheet has not arrived.
    ov.setAttribute("style", [
      "position:fixed", "inset:0", "z-index:2147483647",
      "background:var(--color-surface,#F2F1ED)", "color:var(--color-ink,#16150F)",
      "display:flex", "align-items:center", "justify-content:center",
      "font-family:var(--font-sans,'DM Sans',ui-sans-serif,system-ui,sans-serif)"
    ].join(";"));
    ov.innerHTML =
      '<div style="width:320px;max-width:88vw;text-align:center">' +
        '<div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--color-accent,#C2410C);margin-bottom:18px">Greta</div>' +
        '<div style="font-size:15px;color:var(--color-muted,#57544D);margin-bottom:18px">Enter the access code to view this workspace.</div>' +
        '<input id="oi-gate-input" type="password" autocomplete="off" placeholder="Access code" aria-label="Access code" ' +
          'style="width:100%;padding:11px 13px;border-radius:var(--radius-md,5px);border:1px solid var(--color-line-strong,#CFCCC5);background:var(--color-panel,#fff);color:var(--color-ink,#16150F);font-size:14px;text-align:center;font-family:inherit" />' +
        '<button id="oi-gate-btn" style="width:100%;margin-top:10px;padding:11px;border:0;border-radius:var(--radius-md,5px);background:var(--color-accent,#C2410C);color:var(--color-panel,#fff);font-weight:600;font-size:14px;cursor:pointer;font-family:inherit">Unlock</button>' +
        '<div id="oi-gate-err" role="alert" style="height:16px;margin-top:10px;font-size:12px;color:var(--color-danger,#B42318)"></div>' +
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
