/**
 * Floating trigger styles. Physical corners (`bottom-right` means the right
 * edge in RTL too — it's a screen position, not a reading direction).
 * Below 640px it collapses to a slim edge tab so it never covers content or
 * the host's own bottom navigation.
 */
export const TRIGGER_CSS = `
.sp-trigger{position:fixed;z-index:2147483000;display:inline-flex;align-items:center;justify-content:center;gap:8px;
box-sizing:border-box;height:44px;min-width:44px;padding:0 12px;margin:0;border:0;border-radius:var(--sp-radius-trigger,999px);
background:var(--sp-primary,#18181b);color:var(--sp-primary-text,#fff);box-shadow:var(--sp-shadow-trigger);
font:500 14px/1 var(--sp-font,system-ui,sans-serif);letter-spacing:-.005em;cursor:pointer;-webkit-tap-highlight-color:transparent;
transition:transform .18s cubic-bezier(.2,.8,.2,1),box-shadow .18s,background-color .15s,opacity .2s;
animation:sp-trigger-in .28s cubic-bezier(.2,.8,.2,1) both}
.sp-trigger[data-labelled]{padding:0 16px 0 13px}
.sp-trigger:hover{background:var(--sp-primary-hover,#303036);transform:translateY(-1px)}
.sp-trigger:active{transform:translateY(0) scale(.97)}
.sp-trigger:focus{outline:none}
.sp-trigger:focus-visible{outline:2px solid var(--sp-ring,#2563eb);outline-offset:3px}
.sp-trigger svg{width:20px;height:20px;flex:none}
.sp-trigger[data-position="bottom-right"]{bottom:var(--sp-offset,20px);right:var(--sp-offset,20px)}
.sp-trigger[data-position="bottom-left"]{bottom:var(--sp-offset,20px);left:var(--sp-offset,20px)}
.sp-trigger[data-position="top-right"]{top:var(--sp-offset,20px);right:var(--sp-offset,20px)}
.sp-trigger[data-position="top-left"]{top:var(--sp-offset,20px);left:var(--sp-offset,20px)}
.sp-trigger[aria-expanded="true"]{opacity:0;pointer-events:none;transform:scale(.9)}
.sp-tip{position:absolute;bottom:calc(100% + 10px);right:0;white-space:nowrap;padding:6px 9px;border-radius:7px;
background:var(--sp-text,#18181b);color:var(--sp-bg,#fff);font:500 12px/1.2 var(--sp-font,system-ui);opacity:0;transform:translateY(3px);
pointer-events:none;transition:opacity .15s,transform .15s;box-shadow:0 4px 12px -2px rgba(0,0,0,.25)}
.sp-trigger[data-position$="left"] .sp-tip{right:auto;left:0}
.sp-trigger[data-position^="top"] .sp-tip{bottom:auto;top:calc(100% + 10px);transform:translateY(-3px)}
.sp-tip kbd{font:inherit;opacity:.7;margin-inline-start:6px}
.sp-trigger:hover .sp-tip,.sp-trigger:focus-visible .sp-tip{opacity:1;transform:none;transition-delay:.35s}
@media (max-width:640px){
.sp-trigger{height:52px;width:30px;min-width:30px;padding:0;gap:0;border-radius:10px 0 0 10px;right:0!important;left:auto!important;top:auto!important;bottom:28%!important}
.sp-trigger[data-position$="left"]{left:0!important;right:auto!important;border-radius:0 10px 10px 0}
.sp-trigger svg{width:17px;height:17px}
.sp-trigger:hover{transform:none}
.sp-trigger-label,.sp-tip{display:none}
}
@keyframes sp-trigger-in{from{opacity:0;transform:translateY(6px) scale(.94)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.sp-trigger,.sp-tip{animation:none;transition:none}.sp-trigger:hover{transform:none}}
`;
