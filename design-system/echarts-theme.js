/* ============================================================================
 * Quantichy Design System — Apache ECharts theme
 * ----------------------------------------------------------------------------
 * Registers a single named theme ("quantichy") that maps every visual knob
 * ECharts exposes — palette, axes, grids, tooltip, legend, fonts — onto our
 * design tokens (tokens.css). Charts created with `echarts.init(dom,
 * "quantichy")` inherit the dashboard's typography and color language for
 * free; brand updates to the tokens propagate automatically on the next
 * page load.
 *
 * Usage:
 *   <script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
 *   <script src="design-system/echarts-theme.js"></script>
 *   <script>
 *     QDSCharts.register();                     // once at boot
 *     const c = echarts.init(el, 'quantichy');  // every chart
 *     c.setOption({ series: [...] });
 *   </script>
 *
 * Companion helpers exported on `window.QDSCharts`:
 *   register()           — register the theme (idempotent)
 *   tooltipFormatter(fn) — returns a formatter that renders a token-styled
 *                          tooltip card; pass a function that maps a param
 *                          (or array of params) → { date, rows: [{label,
 *                          value, color}] } and we handle layout/HTML.
 *   resize(charts)       — wires window resize → chart.resize() for an array
 *                          of ECharts instances.
 * ========================================================================= */

(function () {
  'use strict';

  /* Read a --css-var off :root, with a hard-coded fallback for the rare
     case where this script loads before tokens.css (defensive — shouldn't
     happen in normal load order). */
  function tok(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
      return v || fallback;
    } catch (_) {
      return fallback;
    }
  }

  /* Build the theme JSON fresh from current token values. Called by
     register(); kept as its own function so we can later expose a
     reload() if dark mode toggles tokens at runtime. */
  function buildTheme() {
    const FONT_BODY    = tok('--font-body',    "'Inter', sans-serif");
    const FONT_MONO    = tok('--font-mono',    "'Space Mono', monospace");
    const FONT_HEADING = tok('--font-heading', "'Proxima Nova', sans-serif");

    const TEXT_PRIMARY   = tok('--text-primary',   '#0F172A');
    const TEXT_SECONDARY = tok('--text-secondary', '#64748B');
    const TEXT_MUTED     = tok('--text-muted',     '#94A3B8');
    const SURFACE_CARD   = tok('--surface-card',   '#FFFFFF');
    const BORDER_SUBTLE  = tok('--border-subtle',  '#F1F5F9');
    const BORDER_DEFAULT = tok('--border-default', '#E2E8F0');

    const SUCCESS    = tok('--success',        '#10B981');
    const SUCCESS_S  = tok('--success-strong', '#16A34A');
    const DANGER     = tok('--danger',         '#EF4444');
    const DANGER_S   = tok('--danger-strong',  '#DC2626');
    const WARNING    = tok('--warning',        '#F59E0B');
    const INFO       = tok('--info',           '#3B82F6');
    const INFO_DEEP  = tok('--info-deep',      '#1D4ED8');
    const SERIES_4   = tok('--series-4',       '#8B5CF6');
    const SERIES_5   = tok('--series-5',       '#EC4899');
    const SERIES_6   = tok('--series-6',       '#06B6D4');

    /* Brand-aligned categorical palette — first 3 are semantic
       (info / success / danger) so single-series charts pick a sensible
       default; remaining slots add hue diversity for multi-series. */
    const palette = [INFO, SUCCESS, DANGER, WARNING, SERIES_4, SERIES_5, SERIES_6, INFO_DEEP];

    return {
      color: palette,
      backgroundColor: 'transparent',
      textStyle: {
        fontFamily: FONT_BODY,
        color: TEXT_PRIMARY
      },

      title: {
        textStyle: {
          fontFamily: FONT_HEADING,
          fontWeight: 700,
          color: TEXT_PRIMARY,
          fontSize: 15
        },
        subtextStyle: {
          fontFamily: FONT_BODY,
          color: TEXT_MUTED,
          fontSize: 11
        }
      },

      legend: {
        textStyle: {
          fontFamily: FONT_BODY,
          color: TEXT_SECONDARY,
          fontSize: 11
        },
        itemWidth: 10,
        itemHeight: 10,
        itemGap: 14
      },

      tooltip: {
        backgroundColor: SURFACE_CARD,
        borderColor: BORDER_DEFAULT,
        borderWidth: 1,
        padding: [10, 14],
        extraCssText:
          'box-shadow: 0 8px 32px rgba(15,23,42,.14); border-radius: 12px;',
        textStyle: {
          fontFamily: FONT_BODY,
          color: TEXT_PRIMARY,
          fontSize: 12
        },
        axisPointer: {
          lineStyle: { color: BORDER_DEFAULT, width: 1 },
          crossStyle: { color: BORDER_DEFAULT },
          shadowStyle: { color: 'rgba(15,23,42,.04)' }
        }
      },

      grid: {
        left: 8,
        right: 8,
        top: 16,
        bottom: 8,
        containLabel: true
      },

      categoryAxis: {
        axisLine:  { show: false, lineStyle: { color: BORDER_DEFAULT } },
        axisTick:  { show: false },
        splitLine: { show: false },
        axisLabel: {
          color: TEXT_MUTED,
          fontFamily: FONT_BODY,
          fontSize: 10
        }
      },
      valueAxis: {
        axisLine:  { show: false },
        axisTick:  { show: false },
        splitLine: { show: true, lineStyle: { color: BORDER_SUBTLE, type: 'solid' } },
        axisLabel: {
          color: TEXT_MUTED,
          fontFamily: FONT_MONO,
          fontSize: 10
        }
      },
      logAxis: {
        axisLabel: { color: TEXT_MUTED, fontFamily: FONT_MONO, fontSize: 10 },
        splitLine: { lineStyle: { color: BORDER_SUBTLE } }
      },
      timeAxis: {
        axisLabel: { color: TEXT_MUTED, fontFamily: FONT_BODY, fontSize: 10 },
        splitLine: { lineStyle: { color: BORDER_SUBTLE } }
      },

      line: {
        itemStyle: { borderWidth: 0 },
        lineStyle: { width: 2.5 },
        symbol:     'circle',
        symbolSize: 0,           /* points hidden by default — show on hover */
        smooth:     true
      },
      bar: {
        itemStyle: { borderRadius: [6, 6, 0, 0] }
      },
      pie: {
        itemStyle: { borderColor: SURFACE_CARD, borderWidth: 2 }
      },
      gauge: {
        axisLine:  { lineStyle: { color: [[0.4, DANGER], [0.7, WARNING], [1, SUCCESS_S]] } },
        title:     { color: TEXT_SECONDARY, fontFamily: FONT_BODY },
        detail:    { color: TEXT_PRIMARY,   fontFamily: FONT_MONO, fontWeight: 700 },
        pointer:   { itemStyle: { color: TEXT_PRIMARY } }
      }
    };
  }

  /* ---- Public API ---- */

  let _registered = false;

  /* Register the theme once. Safe to call repeatedly — second+ calls
     no-op. Returns false if `echarts` global is missing (so the caller
     can fall back to Chart.js without throwing). */
  function register() {
    if (_registered) return true;
    if (typeof echarts === 'undefined') {
      console.warn('[QDSCharts] echarts global not found — load echarts.min.js before this script.');
      return false;
    }
    echarts.registerTheme('quantichy', buildTheme());
    _registered = true;
    return true;
  }

  /* HTML tooltip formatter that produces a card matching the dashboard's
     visual language: small muted header, monospaced values, color dots.
     `mapper(params)` should return either:
       { title?: string, rows: [{ label, value, color }] }
     or null/undefined to suppress the tooltip.
     Wrapping the row builder in this helper keeps individual chart
     migrations one-liners. */
  function tooltipFormatter(mapper) {
    return function (params) {
      const out = mapper(params);
      if (!out || !out.rows || !out.rows.length) return '';
      const FONT_MONO = tok('--font-mono', "'Space Mono', monospace");
      const TEXT_PRIMARY   = tok('--text-primary',   '#0F172A');
      const TEXT_SECONDARY = tok('--text-secondary', '#64748B');
      const TEXT_MUTED     = tok('--text-muted',     '#94A3B8');

      const header = out.title
        ? `<div style="font-size:11px;color:${TEXT_SECONDARY};font-weight:600;margin-bottom:8px">${out.title}</div>`
        : '';
      const rows = out.rows.map(r => `
        <div style="display:flex;align-items:center;gap:8px;margin:4px 0">
          ${r.color ? `<span style="width:8px;height:8px;border-radius:50%;background:${r.color};flex-shrink:0"></span>` : ''}
          <span style="font-size:11px;color:${TEXT_MUTED};min-width:64px">${r.label}</span>
          <span style="font-family:${FONT_MONO};font-size:12px;font-weight:700;color:${TEXT_PRIMARY}">${r.value}</span>
        </div>`).join('');
      return header + rows;
    };
  }

  /* Wire window resize → chart.resize() for one or many instances.
     ECharts (unlike Chart.js) doesn't auto-resize on container changes —
     callers must opt in. Returns the cleanup function. */
  function resize(charts) {
    const list = Array.isArray(charts) ? charts : [charts];
    const handler = () => list.forEach(c => c && !c.isDisposed() && c.resize());
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }

  window.QDSCharts = { register, tooltipFormatter, resize, _buildTheme: buildTheme };
})();
