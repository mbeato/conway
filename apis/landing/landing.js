/* === APIMesh Landing — Observable Infrastructure === */

/* --- Copy to clipboard --- */
(function() {
  var block = document.getElementById('install-block');
  var btn = document.getElementById('copy-btn');
  if (!block || !btn) return;
  block.addEventListener('click', function() {
    try {
      navigator.clipboard.writeText('npx @mbeato/apimesh-mcp-server').then(function() {
        btn.textContent = 'copied';
        setTimeout(function() { btn.textContent = 'copy'; }, 1500);
      }).catch(function() {
        btn.textContent = 'failed';
        setTimeout(function() { btn.textContent = 'copy'; }, 1500);
      });
    } catch (e) {
      // Fallback for non-secure contexts
      var ta = document.createElement('textarea');
      ta.value = 'npx @mbeato/apimesh-mcp-server';
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      btn.textContent = 'copied';
      setTimeout(function() { btn.textContent = 'copy'; }, 1500);
    }
  });
})();

/* --- Terminal typing animation --- */
(function() {
  var el = document.getElementById('terminal-output');
  if (!el) return;

  var cycles = [
    { text: '  scanning backlog...', cls: 't-dim' },
    { text: '  \u2192 found: website-vulnerability-scan', cls: 't-text' },
    { text: '  building API...', cls: 't-accent' },
    { text: '  \u2192 generated routes, validation, openapi spec', cls: 't-dim' },
    { text: '  \u2192 pricing: $0.005/call, x402 + MPP + API key', cls: 't-dim' },
    { text: '  running security audit...', cls: 't-accent' },
    { text: '  \u2192 14 rules checked', cls: 't-dim' },
    { text: '  \u2192 0 critical, 0 high, 2 info', cls: 't-text' },
    { text: '  deploying to staging...', cls: 't-green' },
    { text: '  \u2192 integration tests passed (4/4)', cls: 't-dim' },
    { text: '  promoting to production \u2713', cls: 't-green' },
    { text: '  \u2192 live at vulnerability-scan.apimesh.xyz', cls: 't-text' },
  ];

  var lineIndex = 0;
  var charIndex = 0;
  var lines = [];
  var cursor = '<span class="terminal-cursor"></span>';
  var timer = null;
  var paused = false;

  function render() {
    var html = '';
    for (var i = 0; i < lines.length; i++) {
      html += lines[i] + '\n';
    }
    if (lineIndex < cycles.length) {
      var c = cycles[lineIndex];
      var partial = c.text.substring(0, charIndex);
      html += '<span class="' + c.cls + '">' + partial + '</span>' + cursor;
    } else {
      html += cursor;
    }
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
  }

  function typeChar() {
    if (paused) return;

    if (lineIndex >= cycles.length) {
      render();
      timer = setTimeout(function() {
        lines = [];
        lineIndex = 0;
        charIndex = 0;
        typeChar();
      }, 4000);
      return;
    }

    var c = cycles[lineIndex];
    if (charIndex <= c.text.length) {
      render();
      charIndex++;
      var speed = 22 + Math.random() * 18;
      if (charIndex === 1) speed = 200 + Math.random() * 100;
      timer = setTimeout(typeChar, speed);
    } else {
      lines.push('<span class="' + c.cls + '">' + c.text + '</span>');
      lineIndex++;
      charIndex = 0;
      timer = setTimeout(typeChar, 80);
    }
  }

  // Pause when tab not visible
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      paused = true;
      clearTimeout(timer);
    } else {
      paused = false;
      typeChar();
    }
  });

  timer = setTimeout(typeChar, 600);
})();

/* --- Number ticker --- */
(function() {
  var ticked = false;

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 4);
  }

  function formatNum(n) {
    if (n >= 1000) return n.toLocaleString();
    return String(n);
  }

  // Exposed so the tools fetch can trigger it after updating data-target
  window._runTicker = function() {
    var targets = document.querySelectorAll('[data-target]');
    if (ticked) {
      // Re-animate with updated targets
      targets.forEach(function(el) {
        var target = parseInt(el.getAttribute('data-target'), 10);
        if (!target || target === 0) return;
        var start = performance.now();
        var duration = 1500;
        function step(now) {
          var t = Math.min((now - start) / duration, 1);
          var val = Math.round(easeOut(t) * target);
          el.textContent = formatNum(val);
          if (t < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      });
      return;
    }
    ticked = true;
    targets.forEach(function(el) {
      var target = parseInt(el.getAttribute('data-target'), 10);
      if (!target || target === 0) return;
      var start = performance.now();
      var duration = 1500;
      function step(now) {
        var t = Math.min((now - start) / duration, 1);
        var val = Math.round(easeOut(t) * target);
        el.textContent = formatNum(val);
        if (t < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  };

  var obs = new IntersectionObserver(function(entries) {
    entries.forEach(function(e) {
      if (e.isIntersecting) {
        window._runTicker();
        obs.disconnect();
      }
    });
  }, { threshold: 0.3 });

  var ticker = document.querySelector('.stats-ticker');
  if (ticker) obs.observe(ticker);
})();

/* --- Marquee + dynamic tools --- */
(function() {
  var row1 = document.getElementById('marquee-row-1');
  var row2 = document.getElementById('marquee-row-2');
  var countEl = document.getElementById('tools-count');
  var statApis = document.getElementById('stat-apis');
  var statRequests = document.getElementById('stat-requests');

  function makePill(t) {
    var name = t.name.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    return '<a class="marquee-pill" href="https://' + t.subdomain + '.apimesh.xyz" target="_blank" rel="noopener noreferrer">' +
      name + ' <span class="pill-price">\u00b7 ' + t.price + '</span></a>';
  }

  fetch('/api/tools')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (countEl) countEl.textContent = data.count + ' live';
      if (statApis) statApis.setAttribute('data-target', String(data.count));

      // Sum total requests for stats ticker
      var totalReqs = 0;
      data.tools.forEach(function(t) {
        if (t.total_requests) totalReqs += t.total_requests;
      });
      if (statRequests && totalReqs > 0) {
        statRequests.setAttribute('data-target', String(totalReqs));
      }

      // Re-trigger ticker animation with real data
      if (window._runTicker) window._runTicker();

      // Split tools into two groups
      var group1 = [], group2 = [];
      data.tools.forEach(function(t, i) {
        if (i % 2 === 0) group1.push(t);
        else group2.push(t);
      });

      // Build pills — duplicated for seamless loop
      var html1 = group1.map(makePill).join('');
      var html2 = group2.map(makePill).join('');
      if (row1) row1.innerHTML = html1 + html1;
      if (row2) row2.innerHTML = html2 + html2;
    })
    .catch(function() {
      if (countEl) countEl.textContent = '';
    });
})();

/* --- Scroll-velocity marquee effect --- */
(function() {
  var tracks = document.querySelectorAll('.marquee-track');
  if (!tracks.length) return;
  var lastScroll = window.scrollY;
  var baseSpeed = [120, 100]; // match CSS durations
  var resetTimer;

  function onScroll() {
    var delta = Math.abs(window.scrollY - lastScroll);
    lastScroll = window.scrollY;
    // Speed up marquee during fast scroll (lower duration = faster)
    var speedFactor = Math.max(0.4, 1 - delta * 0.008);
    tracks.forEach(function(track, i) {
      track.style.animationDuration = (baseSpeed[i] * speedFactor) + 's';
    });
    clearTimeout(resetTimer);
    resetTimer = setTimeout(function() {
      tracks.forEach(function(track, i) {
        track.style.animationDuration = baseSpeed[i] + 's';
      });
    }, 400);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
})();

/* --- Smooth scroll for nav links --- */
document.querySelectorAll('a[href^="#"]').forEach(function(a) {
  a.addEventListener('click', function(e) {
    var target = document.querySelector(this.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      var links = document.getElementById('nav-links');
      if (links) links.classList.remove('open');
    }
  });
});

/* --- Mobile hamburger --- */
(function() {
  var toggle = document.getElementById('nav-toggle');
  var links = document.getElementById('nav-links');
  if (!toggle || !links) return;
  toggle.addEventListener('click', function() {
    links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(links.classList.contains('open')));
  });
})();
