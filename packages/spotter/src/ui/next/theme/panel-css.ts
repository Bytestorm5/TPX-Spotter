/**
 * Panel styles (shipped with the panel chunk). Everything reads `--sp-*`
 * variables from the theme sheet, uses logical properties so RTL needs no
 * overrides, and drops motion under `prefers-reduced-motion`.
 *
 * Scale: 4px grid (`--sp-unit` = 1rem at comfortable density), type 12 / 13
 * / 14 / 15 / 17, radii from the preset.
 */
export const PANEL_CSS = `
.sp-root{--u:calc(var(--sp-unit,1rem)/4);font-family:var(--sp-font);color:var(--sp-text);font-size:14px;line-height:1.45;
-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-align:start}
.sp-root *,.sp-root *::before,.sp-root *::after{box-sizing:border-box}
.sp-root :where(button,select,textarea,input){font:inherit;color:inherit;letter-spacing:inherit}
.sp-root :where(h2,h3,p,ul,ol,dl,dd,figure){margin:0;padding:0}
.sp-root :where(ul,ol){list-style:none}
.sp-root :where(a){color:inherit}
.sp-root :focus{outline:none}
.sp-root :focus-visible{outline:2px solid var(--sp-ring);outline-offset:2px}
.sp-root [hidden]{display:none!important}
.sp-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* backdrop + dialog */
.sp-backdrop{position:fixed;inset:0;z-index:2147483100;background:rgba(9,9,11,.32);animation:sp-fade .18s ease-out both}
.sp-backdrop[data-layout="split"]{background:var(--sp-overlay)}
.sp-dialog{position:fixed;z-index:2147483101;display:flex;flex-direction:column;overflow:hidden;background:var(--sp-bg);color:var(--sp-text);
border:var(--sp-border-width) solid var(--sp-border);border-radius:var(--sp-radius-panel);box-shadow:var(--sp-shadow-panel);
animation:sp-rise .22s cubic-bezier(.2,.8,.2,1) both}
.sp-dialog[data-layout="compact"]{width:min(var(--sp-panel-width),calc(100vw - 32px));max-height:min(720px,calc(100vh - 104px));bottom:84px;right:20px}
.sp-dialog[data-layout="compact"][data-position="bottom-left"]{right:auto;left:20px}
.sp-dialog[data-layout="compact"][data-position^="top"]{bottom:auto;top:84px}
.sp-dialog[data-layout="compact"][data-position="top-left"]{right:auto;left:20px}
.sp-dialog[data-layout="split"]{inset:0;margin:auto;width:min(1180px,calc(100vw - 48px));height:min(780px,calc(100vh - 48px))}

/* ribbon, header, footer */
.sp-ribbon{display:flex;align-items:center;justify-content:center;gap:6px;padding:5px 12px;background:#fff4d6;color:#7a4b00;
font-size:12px;font-weight:500;border-bottom:1px solid #f3dfa6}
.sp-root[data-scheme="dark"] .sp-ribbon{background:#3a2e12;color:#f6d38b;border-color:#57451b}
.sp-header{display:flex;align-items:center;gap:8px;min-height:52px;padding:10px 12px 10px 18px;border-bottom:1px solid var(--sp-border)}
.sp-header[data-back]{padding-inline-start:10px}
.sp-title{flex:1;min-width:0;font-size:15px;font-weight:600;letter-spacing:-.01em;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-badge{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;background:var(--sp-surface);
border:1px solid var(--sp-border);font-size:11px;font-weight:600;color:var(--sp-text-muted);letter-spacing:.01em}
.sp-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 18px;border-top:1px solid var(--sp-border);
font-size:12px;color:var(--sp-text-muted);background:var(--sp-bg)}
.sp-footer a,.sp-footer button{color:var(--sp-text-muted);text-decoration:none;background:none;border:0;padding:2px 0;cursor:pointer;font-size:12px;border-radius:4px}
.sp-footer a:hover,.sp-footer button:hover{color:var(--sp-text);text-decoration:underline;text-underline-offset:2px}
.sp-footer-start{display:flex;align-items:center;gap:6px}

/* body layouts */
.sp-body{display:flex;flex:1;min-height:0}
.sp-stage{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;background:var(--sp-surface)}
.sp-side{display:flex;flex-direction:column;min-height:0;flex:1}
.sp-dialog[data-layout="split"] .sp-side{flex:none;width:380px;border-inline-start:1px solid var(--sp-border)}
.sp-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:18px;display:flex;flex-direction:column;gap:18px;
scrollbar-width:thin;scrollbar-color:var(--sp-border-strong) transparent}
.sp-actions{display:flex;flex-direction:column;gap:12px;padding:14px 18px 16px;border-top:1px solid var(--sp-border)}
.sp-actions-row{display:flex;gap:8px;justify-content:flex-end}
.sp-actions-row>.sp-btn{flex:1}

/* buttons */
.sp-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:38px;padding:0 14px;border-radius:var(--sp-radius);
border:1px solid transparent;font-size:14px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap;text-decoration:none;
transition:background-color .12s,border-color .12s,color .12s,box-shadow .12s,opacity .12s;user-select:none}
.sp-btn:disabled{opacity:.55;cursor:not-allowed}
.sp-btn svg{width:16px;height:16px;flex:none}
.sp-btn-primary{background:var(--sp-primary);color:var(--sp-primary-text);box-shadow:0 1px 2px rgba(0,0,0,.12),inset 0 1px 0 rgba(255,255,255,.08)}
.sp-btn-primary:not(:disabled):hover{background:var(--sp-primary-hover)}
.sp-btn-secondary{background:var(--sp-bg);color:var(--sp-text);border-color:var(--sp-border);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.sp-btn-secondary:not(:disabled):hover{background:var(--sp-surface);border-color:var(--sp-border-strong)}
.sp-btn-ghost{background:transparent;color:var(--sp-text-muted)}
.sp-btn-ghost:not(:disabled):hover{background:var(--sp-surface);color:var(--sp-text)}
.sp-btn-sm{height:30px;padding:0 10px;font-size:13px;gap:6px}
.sp-btn-sm svg{width:15px;height:15px}
.sp-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex:none;border-radius:8px;border:0;
background:transparent;color:var(--sp-text-muted);cursor:pointer;transition:background-color .12s,color .12s}
.sp-icon-btn:hover{background:var(--sp-surface);color:var(--sp-text)}
.sp-icon-btn:disabled{opacity:.4;cursor:not-allowed;background:transparent}
.sp-icon-btn svg{width:18px;height:18px}
.sp-link{background:none;border:0;padding:0;color:var(--sp-text);font-size:13px;font-weight:500;text-decoration:underline;
text-decoration-color:var(--sp-border-strong);text-underline-offset:3px;cursor:pointer;border-radius:3px}
.sp-link:hover{text-decoration-color:currentColor}
.sp-spinner{width:16px;height:16px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:sp-spin .7s linear infinite}

/* fields */
.sp-field{display:flex;flex-direction:column;gap:7px;min-width:0}
.sp-label-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.sp-label{font-size:13px;font-weight:500;color:var(--sp-text);line-height:1.3}
.sp-optional{font-size:12px;color:var(--sp-text-muted)}
.sp-hint{font-size:12px;color:var(--sp-text-muted);line-height:1.4}
.sp-error{display:flex;align-items:flex-start;gap:6px;font-size:12px;font-weight:500;color:var(--sp-danger);line-height:1.4}
.sp-input,.sp-textarea,.sp-select{width:100%;min-height:38px;padding:8px 11px;border:1px solid var(--sp-border-strong);border-radius:var(--sp-radius);
background:var(--sp-bg);color:var(--sp-text);font-size:14px;line-height:1.45;box-shadow:0 1px 2px rgba(0,0,0,.03);
transition:border-color .12s,box-shadow .12s}
.sp-textarea{min-height:104px;resize:vertical;display:block}
.sp-textarea[data-size="sm"]{min-height:64px}
.sp-input::placeholder,.sp-textarea::placeholder{color:var(--sp-text-muted);opacity:1}
.sp-input:hover,.sp-textarea:hover,.sp-select:hover{border-color:var(--sp-text-muted)}
.sp-input:focus-visible,.sp-textarea:focus-visible,.sp-select:focus-visible{outline:none;border-color:var(--sp-ring);
box-shadow:0 0 0 3px color-mix(in srgb,var(--sp-ring) 22%,transparent)}
.sp-input[aria-invalid="true"],.sp-textarea[aria-invalid="true"],.sp-select[aria-invalid="true"]{border-color:var(--sp-danger)}
.sp-select{appearance:none;padding-inline-end:34px;cursor:pointer;background-image:none}
.sp-select-wrap{position:relative}
.sp-select-wrap svg{position:absolute;inset-inline-end:10px;top:50%;width:16px;height:16px;margin-top:-8px;pointer-events:none;color:var(--sp-text-muted)}
.sp-check{display:flex;align-items:flex-start;gap:9px;font-size:14px;cursor:pointer;line-height:1.4}
.sp-check input{appearance:none;flex:none;width:18px;height:18px;margin:1px 0 0;border:1px solid var(--sp-border-strong);border-radius:5px;
background:var(--sp-bg);display:grid;place-content:center;cursor:pointer;transition:background-color .12s,border-color .12s}
.sp-check input::after{content:"";width:10px;height:6px;border:2px solid var(--sp-primary-text);border-top:0;border-right:0;transform:rotate(-45deg) translateX(1px) translateY(-1px);opacity:0}
.sp-check input:checked{background:var(--sp-primary);border-color:var(--sp-primary)}
.sp-check input:checked::after{opacity:1}
.sp-chips{display:flex;flex-wrap:wrap;gap:6px}
.sp-chip{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border-radius:var(--sp-radius-chip);border:1px solid var(--sp-border);
background:var(--sp-bg);color:var(--sp-text);font-size:13px;font-weight:500;cursor:pointer;transition:background-color .12s,border-color .12s,color .12s}
.sp-chip:hover{border-color:var(--sp-border-strong);background:var(--sp-surface)}
.sp-chip[aria-checked="true"],.sp-chip[aria-pressed="true"]{background:var(--sp-primary);border-color:var(--sp-primary);color:var(--sp-primary-text)}
.sp-rating{display:flex;gap:2px}
.sp-star{width:32px;height:32px;display:grid;place-items:center;border:0;background:none;border-radius:6px;color:var(--sp-border-strong);cursor:pointer}
.sp-star svg{width:22px;height:22px}
.sp-star[data-on]{color:#e5a000}
.sp-file{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--sp-text-muted)}
.sp-file input{position:absolute;width:1px;height:1px;opacity:0}
.sp-disclose{align-self:flex-start;display:inline-flex;align-items:center;gap:5px;background:none;border:0;padding:2px 0;
color:var(--sp-text-muted);font-size:13px;font-weight:500;cursor:pointer;border-radius:4px}
.sp-disclose:hover{color:var(--sp-text)}
.sp-disclose svg{width:15px;height:15px}

/* attachments + plain-language summary */
.sp-attach{display:flex;align-items:center;gap:12px;padding:8px;border:1px solid var(--sp-border);border-radius:calc(var(--sp-radius) + 2px);background:var(--sp-bg)}
.sp-thumb{position:relative;flex:none;width:76px;height:48px;border-radius:6px;overflow:hidden;background:var(--sp-surface);border:1px solid var(--sp-border);padding:0;cursor:pointer}
.sp-thumb img{width:100%;height:100%;object-fit:cover;object-position:top left;display:block}
.sp-attach-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.sp-attach-title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-attach-meta{display:flex;gap:10px;flex-wrap:wrap}
.sp-attach-tools{display:flex;gap:6px;flex-wrap:wrap}
.sp-summary{display:flex;gap:8px;font-size:12px;line-height:1.45;color:var(--sp-text-muted)}
.sp-summary svg{flex:none;width:14px;height:14px;margin-top:1px}

/* annotation stage */
.sp-toolbar{display:flex;align-items:center;justify-content:center;gap:8px;padding:12px 16px 0;flex-wrap:wrap}
.sp-toolgroup{display:flex;align-items:center;gap:2px;padding:3px;border-radius:10px;background:var(--sp-bg);border:1px solid var(--sp-border);
box-shadow:0 1px 2px rgba(0,0,0,.05),0 4px 12px -6px rgba(0,0,0,.12)}
.sp-tool{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:0;border-radius:7px;background:transparent;
color:var(--sp-text-muted);cursor:pointer;transition:background-color .12s,color .12s}
.sp-tool:hover{background:var(--sp-surface);color:var(--sp-text)}
.sp-tool[aria-pressed="true"]{background:var(--sp-primary);color:var(--sp-primary-text)}
.sp-tool:disabled{opacity:.35;cursor:not-allowed;background:transparent}
.sp-tool svg{width:18px;height:18px}
.sp-divider{width:1px;height:20px;background:var(--sp-border);margin:0 3px}
.sp-swatch{width:28px;height:28px;border-radius:7px;border:0;background:transparent;display:grid;place-items:center;cursor:pointer}
.sp-swatch span{width:16px;height:16px;border-radius:50%;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--sp-text) 28%,transparent)}
.sp-swatch[aria-checked="true"]{background:var(--sp-surface-hover)}
.sp-swatch[aria-checked="true"] span{box-shadow:0 0 0 2px var(--sp-bg),0 0 0 4px var(--sp-text-muted)}
.sp-canvas-wrap{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:16px 20px 20px}
.sp-canvas-frame{position:relative;max-width:100%;max-height:100%;border-radius:8px;overflow:hidden;
box-shadow:0 0 0 1px rgba(0,0,0,.08),0 12px 32px -8px rgba(0,0,0,.28);background:var(--sp-bg);line-height:0}
.sp-canvas{display:block;max-width:100%;max-height:100%;touch-action:none;cursor:crosshair}
.sp-canvas:focus-visible{outline:3px solid var(--sp-ring);outline-offset:-3px}
.sp-canvas[data-tool="text"]{cursor:text}
.sp-canvas[data-tool="pin"]{cursor:copy}
.sp-textbox{position:absolute;z-index:2;min-width:140px;padding:6px 8px;border-radius:6px;border:2px solid var(--sp-ring);background:var(--sp-bg);
color:var(--sp-text);font-size:14px;line-height:1.3;box-shadow:0 6px 16px -4px rgba(0,0,0,.3)}
.sp-stage[data-removed] .sp-canvas-wrap,.sp-stage[data-removed] .sp-toolbar{opacity:.35;filter:grayscale(1);pointer-events:none}
.sp-votes{display:inline-flex;align-items:center;gap:3px;margin-inline-start:8px}
.sp-votes svg{width:12px;height:12px}
.sp-stage-hint{padding:0 20px 14px;text-align:center;font-size:12px;color:var(--sp-text-muted)}
.sp-skeleton{width:min(760px,100%);aspect-ratio:16/10;border-radius:8px;display:grid;place-items:center;align-content:center;gap:12px;
background:var(--sp-bg);border:1px solid var(--sp-border);color:var(--sp-text-muted);font-size:13px;position:relative;overflow:hidden}
.sp-skeleton::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,color-mix(in srgb,var(--sp-surface) 80%,transparent) 50%,transparent 70%);
animation:sp-shimmer 1.2s ease-in-out infinite}

/* confirmation */
.sp-done{display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;padding:30px 24px 22px}
.sp-done-icon{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;background:var(--sp-success-surface);color:var(--sp-success);
animation:sp-pop .35s cubic-bezier(.2,1.4,.4,1) both}
.sp-done-icon svg{width:24px;height:24px}
.sp-done h2{font-size:17px;font-weight:600;letter-spacing:-.015em}
.sp-done p{color:var(--sp-text-muted);font-size:14px;max-width:32ch}
.sp-ref{display:inline-flex;align-items:center;gap:4px;height:34px;padding:0 4px 0 12px;border-radius:var(--sp-radius);background:var(--sp-surface);
border:1px solid var(--sp-border);font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.02em;color:var(--sp-text)}
.sp-ref .sp-icon-btn{width:28px;height:28px}
.sp-ref .sp-icon-btn svg{width:15px;height:15px}
.sp-done-actions{display:flex;gap:8px;width:100%;margin-top:6px}
.sp-done-actions>*{flex:1}
.sp-queued{font-size:12px;color:var(--sp-warning)}

/* notices, similar issues, review list, dev details */
.sp-notice{display:flex;gap:10px;padding:10px 12px;border-radius:var(--sp-radius);font-size:13px;line-height:1.45}
.sp-notice svg{flex:none;width:16px;height:16px;margin-top:1px}
.sp-notice[data-tone="danger"]{background:var(--sp-danger-surface);color:var(--sp-danger)}
.sp-notice[data-tone="info"]{background:var(--sp-surface);color:var(--sp-text)}
.sp-list{display:flex;flex-direction:column;border:1px solid var(--sp-border);border-radius:calc(var(--sp-radius) + 2px);overflow:hidden}
.sp-list>li{display:flex;align-items:center;gap:10px;padding:10px 12px;min-height:48px;background:var(--sp-bg)}
.sp-list>li+li{border-top:1px solid var(--sp-border)}
.sp-list-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.sp-list-title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-list-meta{font-size:12px;color:var(--sp-text-muted)}
.sp-list>li[data-removed] .sp-list-title{text-decoration:line-through;color:var(--sp-text-muted)}
.sp-list-icon{flex:none;width:28px;height:28px;border-radius:7px;display:grid;place-items:center;background:var(--sp-surface);color:var(--sp-text-muted)}
.sp-list-icon svg{width:15px;height:15px}
.sp-status{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:999px;font-size:11px;font-weight:600;
background:var(--sp-surface);color:var(--sp-text-muted);border:1px solid var(--sp-border);white-space:nowrap}
.sp-status::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.sp-status[data-status="resolved"]{color:var(--sp-success);background:var(--sp-success-surface);border-color:transparent}
.sp-status[data-status="needs_info"]{color:var(--sp-warning)}
.sp-status[data-status="in_progress"]{color:var(--sp-ring)}
.sp-details{border:1px solid var(--sp-border);border-radius:calc(var(--sp-radius) + 2px);background:var(--sp-bg)}
.sp-details>summary{display:flex;align-items:center;gap:8px;padding:10px 12px;font-size:13px;font-weight:500;cursor:pointer;list-style:none;border-radius:inherit}
.sp-details>summary::-webkit-details-marker{display:none}
.sp-details>summary svg{width:15px;height:15px;color:var(--sp-text-muted);transition:transform .15s}
.sp-details[open]>summary svg{transform:rotate(90deg)}
.sp-details-body{padding:4px 12px 12px;display:flex;flex-direction:column;gap:12px}
.sp-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px}
.sp-kv dt{color:var(--sp-text-muted)}
.sp-kv dd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.sp-code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:8px 10px;border-radius:6px;background:var(--sp-surface);
overflow-wrap:anywhere;color:var(--sp-text)}
.sp-subhead{font-size:12px;font-weight:600;color:var(--sp-text-muted);text-transform:uppercase;letter-spacing:.04em}
.sp-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}

/* picker, recording pill, status badge */
.sp-picker-box{position:fixed;z-index:2147483100;pointer-events:none;border-radius:4px;outline:2px solid var(--sp-ring);
background:color-mix(in srgb,var(--sp-ring) 10%,transparent);transition:all .06s linear}
.sp-picker-tag{position:absolute;bottom:calc(100% + 4px);left:-2px;max-width:320px;padding:3px 7px;border-radius:5px;background:var(--sp-ring);color:#fff;
font:500 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sp-float{position:fixed;z-index:2147483102;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:6px 6px 6px 14px;
border-radius:999px;background:var(--sp-bg);color:var(--sp-text);border:1px solid var(--sp-border);box-shadow:var(--sp-shadow-panel);font-size:13px;font-weight:500;
animation:sp-drop .22s cubic-bezier(.2,.8,.2,1) both;max-width:calc(100vw - 24px)}
.sp-float[data-at="top"]{top:16px}
.sp-float[data-at="bottom"]{bottom:20px;top:auto}
.sp-rec-dot{width:9px;height:9px;border-radius:50%;background:#e5484d;box-shadow:0 0 0 0 rgba(229,72,77,.5);animation:sp-pulse 1.6s infinite}
.sp-status-pill{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 12px 0 10px;border-radius:999px;border:1px solid var(--sp-border);
background:var(--sp-bg);color:var(--sp-text);font-size:13px;font-weight:500;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.sp-status-pill:hover{background:var(--sp-surface)}
.sp-status-pill svg{width:16px;height:16px;color:var(--sp-text-muted)}
.sp-count{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--sp-danger);color:#fff;font-size:11px;font-weight:700;
display:inline-grid;place-items:center}
.sp-popover{position:absolute;z-index:2147483000;margin-top:8px;inset-inline-end:0;width:min(360px,calc(100vw - 24px));max-height:min(520px,70vh);display:flex;flex-direction:column;
background:var(--sp-bg);color:var(--sp-text);border:1px solid var(--sp-border);border-radius:var(--sp-radius-panel);box-shadow:var(--sp-shadow-panel);overflow:hidden;
animation:sp-rise .18s cubic-bezier(.2,.8,.2,1) both}
.sp-thread{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:var(--sp-radius);background:var(--sp-surface);font-size:13px}
.sp-thread-from{font-size:11px;font-weight:600;color:var(--sp-text-muted);text-transform:uppercase;letter-spacing:.04em}
.sp-report{display:flex;flex-direction:column;gap:10px;padding:12px 14px}
.sp-report+.sp-report{border-top:1px solid var(--sp-border)}
.sp-report-head{display:flex;align-items:center;gap:8px}
.sp-report-title{flex:1;min-width:0;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-unread{width:7px;height:7px;border-radius:50%;background:var(--sp-ring);flex:none}

/* small screens: full-screen steps */
@media (max-width:720px){
.sp-dialog[data-layout="split"]{inset:0;width:100%;height:100%;border-radius:0;border:0}
.sp-dialog[data-layout="split"] .sp-side{width:100%;border:0}
.sp-dialog[data-layout="split"][data-step="annotate"] .sp-side{display:none}
.sp-dialog[data-layout="split"][data-step="describe"] .sp-stage{display:none}
.sp-canvas-wrap{padding:12px}
.sp-toolbar{padding:10px 10px 0;gap:6px}
}
@media (min-width:721px){.sp-mobile-only{display:none!important}}
@media (max-width:520px){
.sp-dialog[data-layout="compact"]{left:0!important;right:0!important;bottom:0!important;top:auto!important;width:100%;max-height:calc(100vh - 40px);
border-radius:var(--sp-radius-panel) var(--sp-radius-panel) 0 0;border-bottom:0;animation-name:sp-sheet}
.sp-grid2{grid-template-columns:1fr}
}

@keyframes sp-fade{from{opacity:0}}
@keyframes sp-rise{from{opacity:0;transform:translateY(8px) scale(.985)}}
@keyframes sp-sheet{from{transform:translateY(100%)}}
@keyframes sp-drop{from{opacity:0;transform:translateX(-50%) translateY(-6px)}}
@keyframes sp-pop{from{transform:scale(.6);opacity:0}}
@keyframes sp-spin{to{transform:rotate(360deg)}}
@keyframes sp-shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@keyframes sp-pulse{70%{box-shadow:0 0 0 7px rgba(229,72,77,0)}100%{box-shadow:0 0 0 0 rgba(229,72,77,0)}}
@media (prefers-reduced-motion:reduce){.sp-root *,.sp-root *::before,.sp-root *::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}}
`;
