/**
 * Injected stylesheet for the agy Settings section.
 *
 * Plain CSS in a single <style> element rather than CSS modules: this plugin
 * ships one bundle and cannot rely on the host's bundler to process a
 * `*.module.css` import.
 *
 * Follows DSH's own styling contract (deepseek-harness `docs/web-styling.md`):
 *
 * - Colours come from `--dsw-alias-*` semantic tokens, never literal values, so
 *   the section follows the host's light/dark theme instead of shipping a
 *   second palette that drifts.
 * - Text uses the theme's typography ROLE variables (`--dsw-font-*`, which carry
 *   family + size + line-height + weight together) rather than hand-picked
 *   `font-size`/`font-weight` pairs. A hand-picked 550 is not in the host's
 *   scale and is what made this page read heavier than a native section.
 * - Neutral solid borders draw at `0.5px`, the shared hairline weight.
 * - Controls are NOT styled here: they come from the
 *   `@deepseek-ai/dsh-client-ui-primitives` catalog (Button/Switch/Input/Tag/
 *   StateDot), so focus rings, disabled states and size tiers are the
 *   platform's own. This file covers layout and the data visualisations the
 *   host has no primitive for.
 */

const STYLE_ID = 'dsh-agy-styles'

const CSS = `
.agy-root { display: flex; flex-direction: column; gap: 12px; font: var(--dsw-font-xs-13); }
.agy-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.agy-title { font: var(--dsw-font-base-strong-16); color: var(--dsw-alias-label-primary, #1f2329); }
.agy-sub { margin-top: 3px; font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary, #8f959e); }

.agy-tabs {
  display: flex; align-items: flex-end; gap: 22px; margin-top: 2px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, #eef0f3);
}
.agy-tab {
  position: relative; border: 0; padding: 7px 1px 9px; background: transparent;
  color: var(--dsw-alias-label-tertiary, #8f959e);
  font: var(--dsw-font-xs-13); cursor: pointer;
}
.agy-tab:hover, .agy-tab[data-active="true"] { color: var(--dsw-alias-label-primary, #1f2329); }
/* Active tab is an underline rule, matching the Plugins settings section's own
   tab bar rather than introducing a second, boxed tab idiom. */
.agy-tab[data-active="true"]::after {
  position: absolute; right: 0; bottom: -1px; left: 0; height: 2px;
  border-radius: 2px 2px 0 0; background: var(--dsw-alias-label-primary, #1f2329);
  content: '';
}
.agy-tab:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6);
  outline-offset: 2px;
  border-radius: 4px;
}
.agy-tab .agy-count { margin-left: 5px; font: var(--dsw-font-xxxs-11); color: var(--dsw-alias-label-tertiary, #8f959e); }

/* A failed action states WHAT failed and then WHY, on two lines. The default
   white-space (normal) folds that newline into a space and runs the verdict
   into the upstream error, so the separator has to be preserved here exactly as
   .agy-notice already does for its own multi-line form. */
.agy-error { padding: 9px 12px; border-radius: 8px; font: var(--dsw-font-xxs-12);
  white-space: pre-wrap; overflow-wrap: anywhere;
  color: var(--dsw-alias-state-error-primary, #ec1313);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 10%, transparent); }
/* A non-fatal outcome (a partial import). Neutral, not alarming, and it keeps
   newlines so a list of per-source failures stays readable. */
.agy-notice { padding: 9px 12px; border-radius: 8px; font: var(--dsw-font-xxs-12);
  white-space: pre-wrap; overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary, #61666b);
  background: var(--dsw-alias-bg-layer-2, #f4f5f7); }
.agy-empty { padding: 24px 12px; text-align: center; font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-tertiary, #8f959e); }
.agy-hint { margin: 0; font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary, #8f959e); }
.agy-aside { font: var(--dsw-font-xxxs-11); color: var(--dsw-alias-label-tertiary, #8f959e); }
.agy-grow { flex: 1; }

/* ── Grouping surface ───────────────────────────────────────────────────────
   DSH groups with spacing first and a light container second. A settings page
   built only from tables reads as a spreadsheet, so each block gets a card. */
.agy-card {
  border: 0.5px solid var(--dsw-alias-border-l2, #eef0f3);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3, #fff);
  overflow: hidden;
}
.agy-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 10px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04));
  background: var(--dsw-alias-bg-layer-2, #f9fafb);
}
.agy-card-title { font: var(--dsw-font-xs-strong-13); color: var(--dsw-alias-label-primary, #1f2329); }
.agy-card-body { padding: 6px 12px 8px; }

/* ── Rows inside a card ────────────────────────────────────────────────────
   Follows DSH's own list-row convention (ui-sidebar .panelRow): a 12px-radius
   rounded rect inset 2px from the card edge and transparent at rest. A
   full-bleed rectangle reads as a slab and fights the card's own radius. */
.agy-rows { display: flex; flex-direction: column; gap: 2px; }
/* The live line: one status strip above the rows, present ONLY while upstream
   requests are in flight — an idle pool renders no strip, so quiet stays quiet.
   The pulsing dot is the host StateDot primitive ('ongoing'), so the animation
   is the platform's; this rule is layout and tone only. Sits OUTSIDE .agy-rows,
   so the master list's scroll cap does not scroll the status away. */
.agy-live {
  display: flex; align-items: center; gap: 7px;
  margin: 2px 2px 6px; padding: 7px 8px; border-radius: 10px;
  font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-secondary, #61666b);
  background: var(--dsw-alias-bg-layer-2, #f4f5f7);
}
/* Master/detail: the account list beside the selected account's detail, so a
 * row and the panel it opens stay in view together — but only when the
 * container can host both columns comfortably. The Settings panel gives the
 * wrap ~564px of inline space on desktop (800px modal - 188px nav - 48px
 * padding), so at the panel the split STACKS into one full-width column:
 * 564px cannot host two comfortable columns, and a forced 300px master
 * truncated every email to "a1…" while squeezing the detail to ~280px (the
 * original "panel feels too narrow" report). The breakpoint therefore sits
 * ABOVE the panel width and must stay there; if the host's modal geometry
 * changes, re-measure before moving it. The query is a CONTAINER one because
 * the former viewport @media (max-width: 720px) never fired inside the panel.
 *
 * The containment lives on a dedicated wrapper, NOT on .agy-root:
 * container-type: inline-size applies layout containment, which makes the
 * element a containing block for fixed-position descendants — and the host's
 * Tooltip (used by the thinking-budget fields) positions its bubble with
 * position: fixed. Scoping it here keeps that behaviour intact.
 */
.agy-split-wrap { container-type: inline-size; }
.agy-split { display: grid; grid-template-columns: 1fr; gap: 12px; align-items: start; }
@container (min-width: 700px) {
  .agy-split { grid-template-columns: minmax(0, 300px) minmax(0, 1fr); }
}
/* Cap the master list so a large pool cannot push the detail it opens below the
   fold — the reason the split exists at all. Scoped to the split: the Models tab
   shares .agy-rows for its own long list and must keep growing freely. */
.agy-split .agy-rows { max-height: 300px; overflow-y: auto; }
.agy-rowitem {
  /* Flex-wrap, NOT the former grid-template-columns: minmax(0,1fr) auto.
     A grid's 1fr may shrink to zero, so the identity column yielded all its
     width to the action cluster: at the 300px master column the row's ~167px of
     state badge + Verify/Delete left ~45px for the email (which needs ~177px),
     truncating every address to "a1…" even though the row had room to grow
     downward. With a flex BASIS the actions wrap to a second line instead of
     squeezing the name, and margin-left: auto keeps them right-aligned on the
     same line whenever they do fit. */
  display: flex; flex-wrap: wrap;
  align-items: center; gap: 4px 12px;
  margin: 0 2px; padding: 10px 8px; box-sizing: border-box;
  min-height: 36px; border-radius: 12px; background: transparent;
}
.agy-rowitem[data-clickable="true"] { cursor: pointer; }
.agy-rowitem[data-clickable="true"]:hover {
  background: var(--dsw-alias-interactive-bg-hover, #f4f5f7);
}
.agy-rowitem[data-selected="true"] {
  background: var(--dsw-alias-interactive-bg-hover, #f4f5f7);
}
.agy-rowitem:focus-visible {
  outline: 2px solid var(--dsw-alias-label-primary, #1f2329);
  outline-offset: -2px;
}
.agy-rowmain { min-width: 0; flex: 1 1 160px; display: flex; flex-direction: column; gap: 3px; }
.agy-rowtitle { display: flex; align-items: center; gap: 7px; min-width: 0; }
.agy-rowname {
  font: var(--dsw-font-xs-strong-13); color: var(--dsw-alias-label-primary, #1f2329);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.agy-rowmeta {
  font: var(--dsw-font-xxxs-11); color: var(--dsw-alias-label-tertiary, #8f959e);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* margin-left: auto right-aligns the cluster while it shares a line with the
   identity, and becomes inert once flex-wrap moves it to its own line. */
.agy-rowactions { display: flex; align-items: center; gap: 6px; flex: none; margin-left: auto; }
.agy-state { display: inline-flex; align-items: center; gap: 6px; flex: none; }

.agy-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.agy-actions > :first-child:not(button) { flex: 1; min-width: 150px; }
.agy-detail { display: flex; flex-direction: column; gap: 12px; }

/* ── Metric strip ────────────────────────────────────────────────────────── */
.agy-metrics { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); }
/* No vertical rules between cells: the columns read as separated already by
   the gap and their own left alignment, and the dividers turned a metric strip
   into a spreadsheet grid. */
.agy-metric { padding: 12px 0; }
.agy-metric-k { font: var(--dsw-font-xxxs-11); color: var(--dsw-alias-label-tertiary, #8f959e); }
/* The theme's own role carries family + size + line-height + weight; the
   metric only tightens the tracking. */
.agy-metric-v { margin-top: 4px; font: var(--dsw-font-base-strong-16); letter-spacing: -.015em;
  font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary, #1f2329); }
.agy-metric-v small { margin-left: 2px; font: var(--dsw-font-xxs-strong-12);
  color: var(--dsw-alias-label-tertiary, #8f959e); }
.agy-metric-d { margin-top: 3px; font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary, #8f959e); }

/* ── Token composition ─────────────────────────────────────────────────────
   A share bar per bucket, under the headline metrics. This exists to answer
   "why is cache read larger than the input?" with a proportion instead of
   prose: the cache re-reads the whole prefix each turn, so its share dominates.
   Rows are laid out as label / track / value / percent so the numbers stay in
   columns and remain scannable. */
.agy-compose { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.agy-compose-row {
  display: grid; grid-template-columns: 64px minmax(0,1fr) 56px 44px;
  align-items: center; gap: 10px;
}
.agy-compose-k { font: var(--dsw-font-xxxs-11); color: var(--dsw-alias-label-tertiary, #8f959e); }
.agy-compose-track {
  height: 6px; border-radius: 3px; overflow: hidden;
  background: var(--dsw-alias-border-l2, rgba(0,0,0,.12));
}
.agy-compose-track i { display: block; height: 100%; border-radius: 3px; }
.agy-compose-v { text-align: right; font: var(--dsw-font-xxs-12);
  font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #61666b); }
.agy-compose-p { text-align: right; font: var(--dsw-font-xxxs-11);
  font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #8f959e); }
/* A table's own footnote: states a column's scope that its header cannot. */
.agy-table-note { padding: 6px 8px 2px; }
/* The 65535 row is a CONFIGURATION of High, not a sibling tier: indenting it
   makes the dependency visible without adding a column or a badge. */
.agy-table td.agy-nested { padding-left: 20px; font-weight: 400; }

/* ── Definition rows (label / value pairs) ───────────────────────────────── */
.agy-defs { display: grid; grid-template-columns: 92px minmax(0,1fr); margin: 0; }
.agy-defs dt {
  padding: 7px 0; font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary, #8f959e);
  border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04));
}
.agy-defs dd {
  margin: 0; padding: 7px 0; font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-secondary, #61666b);
  border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04));
  overflow-wrap: anywhere;
}
.agy-defs dt:last-of-type, .agy-defs dd:last-of-type { border-bottom: 0; }

/* ── Disclosure (the collapsible model-quota block) ──────────────────────── */
.agy-disclosure { border-top: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04)); }
.agy-disclosure-toggle {
  display: flex; align-items: center; gap: 7px; width: 100%;
  padding: 9px 0; border: 0; cursor: pointer;
  font: var(--dsw-font-xxs-strong-12); text-align: left;
  color: var(--dsw-alias-label-secondary, #61666b); background: none;
}
.agy-disclosure-toggle:hover { color: var(--dsw-alias-label-primary, #1f2329); }
.agy-caret {
  flex: none; width: 0; height: 0; border-left: 4px solid currentColor;
  border-top: 3.5px solid transparent; border-bottom: 3.5px solid transparent;
  transition: transform .15s ease;
}
.agy-disclosure[data-open="true"] .agy-caret { transform: rotate(90deg); }
.agy-disclosure-body { padding-bottom: 8px; }
/* One row per reasoning level: label, then the budget input. The input is
   width-capped so the empty state reads as "no value set" rather than as a wide
   field waiting to be filled. */
/* Label | input | chips. Two content columns plus shortcuts, with real vertical
   breathing room: the earlier three-column version (label | input | a sentence
   restating the row's own label) packed four rows into 5px padding and 10px gaps,
   which read as one solid block. */
.agy-thinking-group { display: flex; flex-direction: column; }
.agy-thinking-group + .agy-thinking-group { margin-top: 16px; }
.agy-thinking-group-name {
  font: var(--dsw-font-xxs-strong-12); color: var(--dsw-alias-label-secondary, #61666b);
  margin-bottom: 2px;
}
.agy-thinking-group .agy-hint { margin: 0 0 8px; }
/* The four things a reader can actually DO with this setting. A list, because
   each is an independent action, and prose buried them. */
.agy-thinking-effects { margin: 2px 0 10px; }
/* Claude's three differences, as a list: each is an independent axis, and the
   last one is why that group has no reference table. */
.agy-thinking-notes { margin: 0 0 8px; padding-left: 18px; }
.agy-thinking-notes li {
  font: var(--dsw-font-xxxs-11); color: var(--dsw-alias-label-tertiary, #8f959e);
  line-height: 1.6;
}
.agy-thinking-row {
  display: grid; grid-template-columns: 72px minmax(0, 180px) auto;
  align-items: center; gap: 14px; padding: 8px 0;
}
.agy-thinking-k { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-secondary, #61666b); }
/* Shortcut chips, not a second control: they fill the field beside them. */
.agy-thinking-chips { display: flex; gap: 6px; }
.agy-thinking-chip {
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.15));
  background: transparent; cursor: pointer; border-radius: 10px;
  padding: 2px 8px; font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-secondary, #61666b);
}
.agy-thinking-chip:hover { background: var(--dsw-alias-interactive-bg-hover); }
.agy-thinking-chip:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4176e6); outline-offset: 1px;
}
.agy-disclosure-meta { margin-left: auto; font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary, #8f959e); font-variant-numeric: tabular-nums; }

/* ── 5h / weekly limits ────────────────────────────────────────────────────
   One group per upstream group (Gemini, Claude+GPT), each with its windows.
   The rows are a fixed 4-column grid so the bars and the percentages line up
   across groups: label / bar / percentage / reset countdown. */
.agy-limits { display: flex; flex-direction: column; gap: 10px; padding: 4px 0; }
.agy-limit-age { font: var(--dsw-font-xxxs-11); color: var(--dsw-alias-label-tertiary, #8f959e); }
.agy-limit-group { display: flex; flex-direction: column; gap: 2px; }
.agy-limit-group-name {
  font: var(--dsw-font-xxs-strong-12); color: var(--dsw-alias-label-secondary, #61666b);
  padding-bottom: 2px;
}
.agy-limit-row {
  display: grid; grid-template-columns: 58px minmax(0,1fr) 40px minmax(0,auto);
  align-items: center; gap: 10px; padding: 4px 0;
  font: var(--dsw-font-xxs-12);
}
.agy-limit-k { color: var(--dsw-alias-label-secondary, #61666b); }
.agy-limit-track { height: 6px; border-radius: 3px; overflow: hidden;
  background: var(--dsw-alias-border-l2, rgba(0,0,0,.12)); }
.agy-limit-track i { display: block; height: 100%; border-radius: 3px; }
.agy-limit-p { text-align: right; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, #1f2329); }
.agy-limit-reset { text-align: right; font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary, #8f959e); }
/* The burn projection: indented to align with the bar (58px label + 10px gap),
   warn-tinted because "this window runs dry before it resets" is the one
   projection that asks the reader to act. */
.agy-limit-burn { padding: 0 0 4px 68px;
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-state-warn-primary, #f59e0b); }

/* ── Dense breakdown tables (Usage tab only) ─────────────────────────────── */
.agy-table-wrap { padding: 6px 0 2px; }
.agy-table { width: 100%; border-collapse: collapse; font: var(--dsw-font-xs-13); table-layout: fixed; }
.agy-table th {
  text-align: left; padding: 0 8px 7px; font: var(--dsw-font-xxxs-strong-11);
  color: var(--dsw-alias-label-tertiary, #8f959e);
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, #eef0f3); white-space: nowrap;
}
.agy-table td { padding: 8px; vertical-align: middle; color: var(--dsw-alias-label-secondary, #61666b);
  border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,.04)); }
.agy-table tr:last-child td { border-bottom: 0; }
.agy-table tbody tr:hover td { background: var(--dsw-alias-bg-layer-2, #f4f5f7); }
.agy-num { text-align: right; font-variant-numeric: tabular-nums; }
/* Numeric HEADERS must right-align too, and .agy-num alone cannot do it: the
   .agy-table th rule above is specificity 0-1-1 and outranks the bare .agy-num
   class (0-1-0), so every numeric th stayed left while its td cells
   right-aligned — the header label sat at the column's left edge with its
   figure out at the right, which is what read as "the data is skewed right".
   Matching the cell class on the header element (0-2-1) wins instead of
   escalating with !important. */
.agy-table th.agy-num { text-align: right; }
/* Inline emphasis on a table cell: a strong role, not a heavier size. */
.agy-strong { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 500; }
.agy-mail { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agy-mono { font-family: var(--ds-font-family-code); }
/* The one external link in the section (a verification appeal URL). Colored and
   underlined with theme tokens rather than left to the browser default, which
   ignores both the light/dark theme and the host's brand color. */
.agy-link { color: var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6); text-decoration: underline; }
.agy-link:hover { opacity: 0.8; }

.agy-bar { display: inline-flex; align-items: center; gap: 8px; justify-content: flex-end; }
.agy-bar .agy-track { width: 56px; height: 4px; border-radius: 2px; overflow: hidden;
  background: var(--dsw-alias-border-l2, rgba(0,0,0,.12)); }
.agy-bar .agy-track i { display: block; height: 100%; border-radius: 2px;
  background: var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6); }

/* ── Range picker container ────────────────────────────────────────────────
   The pills themselves are the host Pill primitive (its own fill pair and
   active state); this only lays them out in a row. */
.agy-chips { display: flex; gap: 6px; }

/* Danger has no primitive variant; keep the ghost skin and tint the label. */
.agy-btn-danger { color: var(--dsw-alias-state-error-primary, #ec1313) !important; }

/* ── Recent activity ring ──────────────────────────────────────────────────
   The "what just happened" list. Only the result cell carries color — ok
   inherits the table's neutral, and a wall of tinted rows would read as an
   alarm rather than a log. */
.agy-recent-state { font: var(--dsw-font-xxs-12); }
.agy-recent-state[data-kind="fail"] { color: var(--dsw-alias-state-error-primary, #ec1313); }
.agy-recent-state[data-kind="limited"] { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.agy-recent-state[data-kind="rotation"] { color: var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6); }
/* The recent list is a standalone disclosure on the tab root, not one block
   inside a card body — the separator border-top the disclosure idiom uses
   between sibling blocks would draw a stray line across nothing here. */
.agy-recent.agy-disclosure { border-top: 0; }

.agy-toolbar { display: flex; align-items: center; gap: 8px; }
.agy-textarea { width: 100%; min-height: 88px; resize: vertical; outline: none;
  padding: 9px 10px; font: var(--dsw-font-xxs-12); font-family: var(--ds-font-family-code);
  color: var(--dsw-alias-label-primary, #1f2329); background: var(--dsw-alias-bg-layer-1, #fff);
  border: 0.5px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 8px; }
.agy-textarea:focus { border-color: var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6); }

/* ── Preferences card ───────────────────────────────────────────────────── */
.agy-pref-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0;
}
.agy-pref-name {
  font: var(--dsw-font-xs-strong-13);
  color: var(--dsw-alias-label-primary, #1f2329);
}
.agy-pref-desc {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-tertiary, #8f959e);
  margin-top: 2px;
}

/* ── Conversation-header quota badge & popover ─────────────────────────── */
.agy-ui-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--dsw-alias-bg-layer-2, #f4f5f7);
  border: 0.5px solid var(--dsw-alias-border-l2, #e5e6eb);
  border-radius: 9999px;
  padding: 3px 10px;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-primary, #1f2329);
  cursor: pointer;
  user-select: none;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  font-family: inherit;
  height: auto;
}

.agy-ui-badge:hover,
.agy-ui-badge.pinned {
  background: var(--dsw-alias-bg-layer-3, #fff);
  border-color: var(--dsw-alias-border-l1, #dee0e3);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.12);
}

.agy-ui-badge.pinned {
  border-color: var(--dsw-alias-brand-primary, #4176e6);
  box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary, #4176e6), 0 3px 10px rgba(0, 0, 0, 0.12);
}

.agy-ui-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: background-color 0.3s;
}

.agy-ui-dot[data-state="done"],
.agy-ui-dot.active {
  background-color: var(--dsw-alias-state-success-primary, #10b981);
  box-shadow: 0 0 6px var(--dsw-alias-state-success-primary, rgba(16, 185, 129, 0.6));
}

.agy-ui-dot[data-state="warning"],
.agy-ui-dot.cooling {
  background-color: var(--dsw-alias-state-warn-primary, #f59e0b);
  box-shadow: 0 0 6px var(--dsw-alias-state-warn-primary, rgba(245, 158, 11, 0.6));
}

.agy-ui-dot[data-state="idle"],
.agy-ui-dot.disabled {
  background-color: var(--dsw-alias-label-tertiary, #8f959e);
}

.agy-ui-dot.updating {
  animation: agy-ui-pulse 1.2s ease-in-out infinite;
}

.agy-ui-dot.active.updating,
.agy-ui-dot[data-state="done"].updating {
  box-shadow: 0 0 10px var(--dsw-alias-state-success-primary, #10b981);
}

.agy-ui-dot.cooling.updating,
.agy-ui-dot[data-state="warning"].updating {
  box-shadow: 0 0 10px var(--dsw-alias-state-warn-primary, #f59e0b);
}

@keyframes agy-ui-pulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.35;
    transform: scale(0.7);
  }
}

.agy-ui-sparkle {
  color: var(--dsw-alias-brand-primary, #4176e6);
  font: var(--dsw-font-xs-13);
}

.agy-ui-popover-container.desktop {
  position: static;
}

.agy-ui-popover-container.mobile {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  animation: agy-ui-fade-in 0.2s ease-out;
}

.agy-ui-popover {
  background: var(--dsw-alias-bg-overlay, #fff);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 0.5px solid var(--dsw-alias-border-l2, #e5e6eb);
  box-shadow: 0 20px 45px rgba(0, 0, 0, 0.15), 0 0 0 0.5px var(--dsw-alias-border-l1, #dee0e3);
  color: var(--dsw-alias-label-primary, #1f2329);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  z-index: 1000;
}

.agy-ui-popover.desktop {
  width: 380px;
  max-width: calc(100vw - 24px);
  border-radius: 14px;
  animation: agy-ui-popover-in 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

.agy-ui-popover.mobile {
  width: 100%;
  max-height: 82vh;
  border-radius: 20px 20px 0 0;
  border-bottom: none;
  animation: agy-ui-bottom-sheet-in 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.agy-ui-mobile-handle {
  width: 36px;
  height: 4px;
  background: var(--dsw-alias-border-l2, #e5e6eb);
  border-radius: 9999px;
  margin: 8px auto 2px auto;
}

@keyframes agy-ui-popover-in {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes agy-ui-bottom-sheet-in {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}

@keyframes agy-ui-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.agy-ui-modal-header {
  padding: 10px 14px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e5e6eb);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--dsw-alias-bg-layer-1, #fff);
}

.agy-ui-modal-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font: var(--dsw-font-xs-strong-13);
  color: var(--dsw-alias-label-primary, #1f2329);
}

.agy-ui-pinned-tag {
  font: var(--dsw-font-xxxs-11);
  margin-left: 2px;
}

.agy-ui-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.agy-ui-icon-btn {
  color: var(--dsw-alias-label-secondary, #646a73);
  padding: 4px;
  min-width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.15s;
}

.agy-ui-icon-btn:hover {
  color: var(--dsw-alias-label-primary, #1f2329);
  background: var(--dsw-alias-bg-layer-2, #f4f5f7);
}

.agy-ui-icon-btn.active {
  color: var(--dsw-alias-brand-primary, #4176e6);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4176e6) 18%, transparent);
}

.agy-ui-icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.agy-ui-spinning {
  animation: agy-ui-spin 1s linear infinite;
}

@keyframes agy-ui-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.agy-ui-modal-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 480px;
}

.agy-ui-account-card {
  background: var(--dsw-alias-bg-layer-2, #f4f5f7);
  border: 0.5px solid var(--dsw-alias-border-l1, #dee0e3);
  border-radius: 9px;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.agy-ui-account-email {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-primary, #1f2329);
}

.agy-ui-account-project {
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary, #8f959e);
  margin-top: 2px;
}

.agy-ui-state-pill {
  font: var(--dsw-font-xxxs-11);
  padding: 2px 7px;
  border-radius: 9999px;
  text-transform: capitalize;
}

.agy-ui-state-pill.active {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #10b981) 15%, transparent);
  color: var(--dsw-alias-state-business-primary, #10b981);
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #10b981) 30%, transparent);
}

.agy-ui-state-pill.cooling {
  background: color-mix(in srgb, var(--dsw-alias-state-error-secondary, #f59e0b) 15%, transparent);
  color: var(--dsw-alias-state-error-secondary, #f59e0b);
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-error-secondary, #f59e0b) 30%, transparent);
}

.agy-ui-state-pill.verification-required {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4176e6) 15%, transparent);
  color: var(--dsw-alias-brand-primary, #4176e6);
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4176e6) 30%, transparent);
}

.agy-ui-state-pill.disabled {
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #8f959e) 15%, transparent);
  color: var(--dsw-alias-label-secondary, #646a73);
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-label-tertiary, #8f959e) 30%, transparent);
}

.agy-ui-section-label {
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary, #8f959e);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.agy-ui-quota-card {
  background: var(--dsw-alias-bg-layer-2, #f4f5f7);
  border: 0.5px solid var(--dsw-alias-border-l1, #dee0e3);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.agy-ui-quota-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2px;
}

.agy-ui-model-name {
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-label-primary, #1f2329);
}

.agy-ui-limit-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.agy-ui-limit-row + .agy-ui-limit-row {
  margin-top: 5px;
}

.agy-ui-limit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font: var(--dsw-font-xxxs-11);
}

.agy-ui-limit-title {
  color: var(--dsw-alias-label-secondary, #646a73);
  font: var(--dsw-font-xxxs-11);
}

.agy-ui-limit-percent {
  font: var(--dsw-font-xxs-12);
  font-variant-numeric: tabular-nums;
}

.agy-ui-progress-track {
  width: 100%;
  height: 5px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 8%, transparent);
  border-radius: 9999px;
  overflow: hidden;
}

.agy-ui-progress-fill {
  height: 100%;
  border-radius: 9999px;
  transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.agy-ui-quota-footer {
  display: flex;
  justify-content: flex-end;
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary, #8f959e);
  font-variant-numeric: tabular-nums;
}

.agy-ui-modal-footer {
  padding: 8px 14px;
  border-top: 0.5px solid var(--dsw-alias-border-l2, #e5e6eb);
  background: var(--dsw-alias-bg-layer-1, #fff);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary, #8f959e);
}

.agy-ui-window-note {
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary, #8f959e);
  margin-top: 3px;
  padding: 8px 0;
}

.agy-ui-limit-age {
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-label-tertiary, #8f959e);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.agy-ui-verify-note {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font: var(--dsw-font-xxs-12);
  color: var(--dsw-alias-brand-primary, #4176e6);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4176e6) 10%, transparent);
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4176e6) 30%, transparent);
  border-radius: 9999px;
  padding: 6px 12px;
}

.agy-ui-link-btn {
  color: var(--dsw-alias-brand-primary, #4176e6);
  text-decoration: none;
  font: var(--dsw-font-xxs-12);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  transition: color 0.15s;
  background: none;
  border: none;
  padding: 0;
}

.agy-ui-link-btn:hover {
  text-decoration: underline;
}

@media (max-width: 640px) {
  .agy-ui-badge {
    padding: 2px 7px;
    font: var(--dsw-font-xxxs-11);
    gap: 4px;
  }
  .agy-ui-modal-body {
    padding: 12px 14px;
    gap: 10px;
  }
}
`

/** Install the stylesheet once (idempotent across plugin reloads): a second
 *  install never appends a duplicate, and one whose content has gone stale
 *  (a previous bundle's CSS) is refreshed in place. The disposer is
 *  deliberately a NO-OP — it runs on every Cordis effect re-evaluation, and
 *  removing the element there stripped every .agy-* style mid-session; the
 *  element is unique by id and inert once the section is gone. */
export function installAgyStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) {
    if (existing.textContent !== CSS) existing.textContent = CSS
    return () => {}
  }
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
  return () => {}
}
