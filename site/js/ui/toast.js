/*
 * Toasts: short status messages at the bottom of the screen, announced by the #toasts live region.
 * toast('Saved') · toast('Update ready', { action: 'Reload', onAction: () => location.reload(), timeout: 0 })
 * A toast with an action stays until used or dismissed (timeout 0); an `id` replaces an earlier toast with that id.
 */
import { h } from './dom.js';

export function toast(message, { action, onAction, timeout = 3500, id } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return () => {};
  if (id) host.querySelector(`[data-toast-id="${CSS.escape(id)}"]`)?.remove();
  const close = () => el.remove();
  const el = h('div', { class: 'toast', dataset: id ? { toastId: id } : undefined },
    h('span', { class: 'msg', text: message }),
    action && h('button', { class: 'btn small primary', type: 'button', text: action, onclick: () => { close(); onAction?.(); } }),
    h('button', { class: 'icon-btn mini', type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss', text: '×', onclick: close })
  );
  host.appendChild(el);
  const ms = timeout === undefined ? 3500 : action && timeout === 3500 ? 0 : timeout;
  if (ms > 0) setTimeout(close, ms);
  return close;
}
