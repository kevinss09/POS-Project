import { createClient } from '@supabase/supabase-js';
import './styles.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const app = document.getElementById('app');

if (!supabaseUrl || !supabaseKey) {
  app.innerHTML = `<main class="page"><section class="panel checkout-card"><h2>Supabase setup required</h2><p>Add these values to a <code>.env</code> file:</p><pre>VITE_SUPABASE_URL=...\nVITE_SUPABASE_ANON_KEY=...</pre></section></main>`;
  throw new Error('Missing Supabase environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);

let state = {
  settings: { businessName: 'BingPpang', taxEnabled: false, taxRate: 5 },
  menu: [],
  orders: []
};
let route = location.hash.replace('#', '') || 'pos';
let category = 'Bungeoppang';
let cart = [];
let orderNote = '';
let checkoutMode = null;
let cashReceived = '';
let lastSubmittedOrder = null;
let toastTimer = null;
let loading = true;
let connectionStatus = 'connecting';

window.addEventListener('hashchange', () => {
  route = location.hash.replace('#', '') || 'pos';
  render();
});

function money(value) {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(Number(value || 0));
}
function orderNumber(n) { return `#${String(n).padStart(3, '0')}`; }
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
function rawCartSubtotal() { return cart.reduce((sum, item) => sum + item.price * item.quantity, 0); }
function bungeoppangQuantity() { return cart.filter(i => i.category === 'Bungeoppang').reduce((sum, i) => sum + i.quantity, 0); }
function bundleCount() { return Math.floor(bungeoppangQuantity() / 5); }
function bundleDiscount() { return bundleCount() * 2.5; }
function cartSubtotal() { return Math.max(0, rawCartSubtotal() - bundleDiscount()); }
function cartTax() { return state.settings.taxEnabled ? cartSubtotal() * Number(state.settings.taxRate || 0) / 100 : 0; }
function cartTotal() { return cartSubtotal() + cartTax(); }
function cartCount() { return cart.reduce((sum, item) => sum + item.quantity, 0); }
function activeOrders() { return state.orders.filter(o => o.status === 'preparing').sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); }
function historyOrders() { return state.orders.filter(o => o.status !== 'preparing').sort((a, b) => new Date(b.completedAt || b.canceledAt || b.createdAt) - new Date(a.completedAt || a.canceledAt || a.createdAt)); }
function stationOrders(station) {
  const completedKey = station === 'Bungeoppang' ? 'bungeoppangCompleted' : 'bingsuCompleted';
  const requiredKey = station === 'Bungeoppang' ? 'bungeoppangRequired' : 'bingsuRequired';
  return activeOrders().filter(o => o[requiredKey] && !o[completedKey]);
}

async function loadState() {
  loading = true;
  render();
  const [settingsResult, menuResult, ordersResult] = await Promise.all([
    supabase.from('app_settings').select('*').eq('id', 1).single(),
    supabase.from('menu_items').select('*').order('sort_order'),
    supabase.from('orders').select('*, order_items(*)').order('created_at', { ascending: false }).limit(2000)
  ]);
  const error = settingsResult.error || menuResult.error || ordersResult.error;
  if (error) {
    loading = false;
    showToast(error.message);
    render();
    return;
  }
  state.settings = {
    businessName: settingsResult.data.business_name,
    taxEnabled: settingsResult.data.tax_enabled,
    taxRate: Number(settingsResult.data.tax_rate)
  };
  state.menu = menuResult.data.map(i => ({
    id: i.id,
    category: i.category,
    name: i.name,
    price: Number(i.price),
    soldOut: i.sold_out
  }));
  state.orders = ordersResult.data.map(o => ({
    id: o.id,
    orderNumber: Number(o.order_number),
    note: o.note,
    subtotal: Number(o.subtotal),
    bundleDiscount: Number(o.bundle_discount || 0),
    taxRate: Number(o.tax_rate),
    tax: Number(o.tax),
    total: Number(o.total),
    paymentMethod: o.payment_method,
    cashReceived: o.cash_received === null ? null : Number(o.cash_received),
    status: o.status,
    createdAt: o.created_at,
    completedAt: o.completed_at,
    canceledAt: o.canceled_at,
    bungeoppangRequired: Boolean(o.bungeoppang_required),
    bingsuRequired: Boolean(o.bingsu_required),
    bungeoppangCompleted: Boolean(o.bungeoppang_completed),
    bingsuCompleted: Boolean(o.bingsu_completed),
    items: (o.order_items || []).map(i => ({
      name: i.name,
      category: i.category,
      unitPrice: Number(i.unit_price),
      quantity: i.quantity,
      lineTotal: Number(i.line_total)
    }))
  }));
  loading = false;
  render();
}

function subscribeRealtime() {
  const channel = supabase.channel('bingppang-pos-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, loadState)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, loadState)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_items' }, loadState)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, loadState)
    .subscribe(status => {
      connectionStatus = status === 'SUBSCRIBED' ? 'live' : status.toLowerCase();
      render();
    });
  window.addEventListener('beforeunload', () => supabase.removeChannel(channel));
}

function showToast(message, actionLabel = null, action = null) {
  clearTimeout(toastTimer);
  document.querySelector('.toast')?.remove();
  const node = document.createElement('div');
  node.className = 'toast';
  node.innerHTML = `<span>${escapeHtml(message)}</span>${actionLabel ? ` <button class="secondary" id="toast-action">${escapeHtml(actionLabel)}</button>` : ''}`;
  document.body.appendChild(node);
  if (actionLabel && action) node.querySelector('#toast-action').onclick = async () => { await action(); node.remove(); };
  toastTimer = setTimeout(() => node.remove(), 5000);
}

function renderShell(content) {
  const navItems = [
    ['pos', 'Cashier'],
    ['prep-bungeoppang', `Bungeoppang (${stationOrders('Bungeoppang').length})`],
    ['prep-bingsu', `Bingsu (${stationOrders('Bingsu').length})`],
    ['history', 'History'],
    ['settings', 'Settings']
  ];
  app.innerHTML = `<div class="app-shell"><header class="topbar"><div class="brand"><div class="brand-mark">🐟</div><div><h1>${escapeHtml(state.settings.businessName)} POS</h1><small>Booth ordering system · ${connectionStatus === 'live' ? 'Live' : 'Connecting…'}</small></div></div><nav class="nav">${navItems.map(([key, label]) => `<button class="${route === key || (route === 'checkout' && key === 'pos') ? 'active' : ''}" onclick="location.hash='${key}'">${label}</button>`).join('')}</nav></header><main class="page">${loading ? '<div class="panel empty-state">Loading…</div>' : content}</main></div>`;
}

function render() {
  if (route === 'prep-bungeoppang') return renderStation('Bungeoppang');
  if (route === 'prep-bingsu') return renderStation('Bingsu');
  if (route === 'history') return renderHistory();
  if (route === 'settings') return renderSettings();
  if (route === 'checkout') return renderCheckout();
  renderPOS();
}

window.addToCart = id => {
  const item = state.menu.find(i => i.id === id);
  if (!item || item.soldOut) return;
  const existing = cart.find(i => i.menuItemId === id);
  if (existing) existing.quantity += 1;
  else cart.push({ menuItemId: id, name: item.name, category: item.category, price: item.price, quantity: 1 });
  render();
};
window.changeQty = (id, delta) => {
  const item = cart.find(i => i.menuItemId === id);
  if (!item) return;
  item.quantity += delta;
  if (item.quantity <= 0) cart = cart.filter(i => i.menuItemId !== id);
  render();
};
window.setCategory = cat => { category = cat; render(); };
window.setOrderNote = value => { orderNote = value; };
window.clearCart = () => { cart = []; orderNote = ''; checkoutMode = null; cashReceived = ''; render(); };

function renderPOS() {
  const items = state.menu.filter(i => i.category === category);
  const discount = bundleDiscount();
  renderShell(`<div class="pos-grid"><section class="panel menu-panel"><div class="category-tabs">${['Bungeoppang', 'Bingsu'].map(cat => `<button class="${category === cat ? 'active' : ''}" onclick="setCategory('${cat}')">${cat}</button>`).join('')}</div><div class="bundle-hint">Bungeoppang bundle: any 5 for $15. Premium flavours remain +$0.50 each.</div><div class="menu-grid">${items.map(item => `<button class="menu-item ${item.soldOut ? 'sold-out' : ''}" ${item.soldOut ? 'disabled' : ''} onclick="addToCart('${item.id}')"><strong>${escapeHtml(item.name)}</strong><span>${money(item.price)}</span>${item.soldOut ? '<span class="soldout-badge">SOLD OUT</span>' : ''}</button>`).join('')}</div></section><aside class="panel cart-panel"><h2 class="section-title">Current Order</h2>${cart.length === 0 ? '<div class="cart-empty">Tap a menu item to begin.</div>' : `<div class="cart-list">${cart.map(item => `<div class="cart-row"><div><strong>${escapeHtml(item.name)}</strong><br><small>${escapeHtml(item.category)} · ${money(item.price)} each</small></div><div class="qty"><button onclick="changeQty('${item.menuItemId}',-1)">−</button><strong>${item.quantity}</strong><button onclick="changeQty('${item.menuItemId}',1)">+</button></div></div>`).join('')}</div><textarea class="note-input" placeholder="Optional order note" oninput="setOrderNote(this.value)">${escapeHtml(orderNote)}</textarea><div class="totals"><div class="total-line"><span>${cartCount()} items</span><strong>${money(rawCartSubtotal())}</strong></div>${discount > 0 ? `<div class="total-line discount-line"><span>${bundleCount()} × 5-piece bundle discount</span><strong>−${money(discount)}</strong></div>` : ''}<div class="total-line"><span>${state.settings.taxEnabled ? `GST (${state.settings.taxRate}%)` : 'Tax'}</span><strong>${money(cartTax())}</strong></div><div class="total-line grand"><span>Total</span><span>${money(cartTotal())}</span></div></div><button class="primary" onclick="location.hash='checkout'">Checkout</button><button class="secondary danger" style="width:100%;margin-top:8px" onclick="clearCart()">Clear order</button>`}</aside></div>`);
}

window.selectPayment = mode => { checkoutMode = mode; render(); };
window.setCashReceived = value => {
  cashReceived = value;
  const received = Number(cashReceived || 0);
  const total = cartTotal();
  const input = document.querySelector('.money-input');
  if (input && input.value !== String(value)) input.value = value;
  const changeEl = document.getElementById('change-due');
  const submitBtn = document.getElementById('submit-order-btn');
  if (changeEl) changeEl.textContent = money(Math.max(0, received - total));
  if (submitBtn && checkoutMode === 'cash') submitBtn.disabled = received < total;
};
window.startNextOrder = () => { lastSubmittedOrder = null; location.hash = 'pos'; };

function renderCheckout() {
  if (cart.length === 0 && !lastSubmittedOrder) { location.hash = 'pos'; return; }
  if (lastSubmittedOrder) return renderShell(`<section class="panel checkout-card"><div class="success-box"><h2>Order ${orderNumber(lastSubmittedOrder.orderNumber)} submitted</h2><p>It has been sent to the correct preparation station${lastSubmittedOrder.bungeoppangRequired && lastSubmittedOrder.bingsuRequired ? 's' : ''}.</p></div><button class="primary" onclick="startNextOrder()">Start Next Order</button></section>`);
  const total = cartTotal();
  const received = Number(cashReceived || 0);
  const change = Math.max(0, received - total);
  const discount = bundleDiscount();
  renderShell(`<section class="panel checkout-card"><h2>Checkout</h2><div class="totals"><div class="total-line"><span>Items</span><strong>${money(rawCartSubtotal())}</strong></div>${discount > 0 ? `<div class="total-line discount-line"><span>Bundle discount</span><strong>−${money(discount)}</strong></div>` : ''}<div class="total-line"><span>${state.settings.taxEnabled ? `GST (${state.settings.taxRate}%)` : 'Tax'}</span><strong>${money(cartTax())}</strong></div><div class="total-line grand"><span>Total</span><span>${money(total)}</span></div></div><div class="payment-options"><button class="payment-option ${checkoutMode === 'cash' ? 'active' : ''}" onclick="selectPayment('cash')">Cash</button><button class="payment-option ${checkoutMode === 'card' ? 'active' : ''}" onclick="selectPayment('card')">Card / Square</button></div>${checkoutMode === 'cash' ? `<label>Cash received<input class="money-input" inputmode="decimal" value="${escapeHtml(cashReceived)}" oninput="setCashReceived(this.value)" placeholder="0.00"></label><div class="quick-cash"><button onclick="setCashReceived('${total.toFixed(2)}')">Exact</button>${[20, 50, 100].map(v => `<button onclick="setCashReceived('${v}')">${money(v)}</button>`).join('')}</div><div class="notice"><strong>Change due: <span id="change-due">${money(change)}</span></strong></div>` : ''}${checkoutMode === 'card' ? `<div class="notice">Open Square and charge <strong>${money(total)}</strong>. Return only after payment succeeds.</div>` : ''}<button id="submit-order-btn" class="primary" ${!checkoutMode || (checkoutMode === 'cash' && received < total) ? 'disabled' : ''} onclick="submitOrder()">Payment Received — Submit Order</button><button class="secondary" style="width:100%;margin-top:8px" onclick="location.hash='pos'">Back to Order</button></section>`);
}

window.submitOrder = async () => {
  const { data, error } = await supabase.rpc('create_pos_order', {
    p_items: cart.map(i => ({ menu_item_id: i.menuItemId, quantity: i.quantity })),
    p_note: orderNote,
    p_payment_method: checkoutMode,
    p_cash_received: checkoutMode === 'cash' ? Number(cashReceived) : null
  });
  if (error) return showToast(error.message);
  await loadState();
  const order = state.orders.find(o => o.id === data);
  lastSubmittedOrder = order || { orderNumber: '?', bungeoppangRequired: false, bingsuRequired: false };
  cart = [];
  orderNote = '';
  checkoutMode = null;
  cashReceived = '';
  render();
};

function elapsed(iso) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

window.completeStation = async (id, number, station) => {
  const { error } = await supabase.rpc('complete_pos_station', { p_order_id: id, p_station: station });
  if (error) return showToast(error.message);
  showToast(`${station} for order ${orderNumber(number)} completed.`, 'Undo', async () => {
    const result = await supabase.rpc('reopen_pos_station', { p_order_id: id, p_station: station });
    if (result.error) showToast(result.error.message);
  });
};

window.cancelSubmittedOrder = async (id, number, paymentMethod) => {
  const refundText = paymentMethod === 'card'
    ? 'Make sure to refund the customer separately in Square.'
    : 'Make sure to return the customer’s cash if needed.';
  const confirmed = confirm(`Cancel order ${orderNumber(number)}?\n\n${refundText}\n\nThis removes it from both preparation pages but keeps it in History.`);
  if (!confirmed) return;
  const { error } = await supabase.rpc('cancel_pos_order', { p_order_id: id });
  if (error) return showToast(error.message);
  showToast(`Order ${orderNumber(number)} canceled.`);
};

function renderStation(station) {
  const orders = stationOrders(station);
  const otherStation = station === 'Bungeoppang' ? 'Bingsu' : 'Bungeoppang';
  renderShell(`<section><h2>${station} Preparation</h2>${orders.length === 0 ? `<div class="panel empty-state"><h3>No ${station.toLowerCase()} orders</h3><p>Paid ${station.toLowerCase()} items will appear here automatically.</p></div>` : `<div class="orders-grid">${orders.map(order => {
    const stationItems = order.items.filter(i => i.category === station);
    const isMixed = order.items.some(i => i.category === otherStation);
    return `<article class="panel order-card"><header><div class="order-number">${orderNumber(order.orderNumber)}</div><div class="order-time">${elapsed(order.createdAt)}</div></header>${isMixed ? `<div class="mixed-badge">Mixed order · also has ${otherStation}</div>` : ''}<div class="order-items">${stationItems.map(i => `<div class="order-item-line"><strong>${i.quantity} × ${escapeHtml(i.name)}</strong><small>${escapeHtml(i.category)}</small></div>`).join('')}</div>${order.note ? `<div class="order-note"><strong>Note:</strong> ${escapeHtml(order.note)}</div>` : ''}<button class="complete-btn" onclick="completeStation('${order.id}',${order.orderNumber},'${station}')">Complete ${station}</button><button class="cancel-order-btn" onclick="cancelSubmittedOrder('${order.id}',${order.orderNumber},'${order.paymentMethod}')">Cancel order</button></article>`;
  }).join('')}</div>`}</section>`);
}

function todayOrders() {
  const today = new Date().toDateString();
  return state.orders.filter(o => new Date(o.createdAt).toDateString() === today);
}

function renderHistory() {
  const orders = historyOrders();
  const today = todayOrders();
  const validToday = today.filter(o => o.status !== 'canceled');
  const canceledToday = today.filter(o => o.status === 'canceled');
  const sales = validToday.reduce((sum, o) => sum + o.total, 0);
  const cash = validToday.filter(o => o.paymentMethod === 'cash').reduce((sum, o) => sum + o.total, 0);
  const card = validToday.filter(o => o.paymentMethod === 'card').reduce((sum, o) => sum + o.total, 0);
  renderShell(`<section><div class="metrics"><div class="panel metric"><span>Today's sales</span><strong>${money(sales)}</strong></div><div class="panel metric"><span>Paid orders</span><strong>${validToday.length}</strong></div><div class="panel metric"><span>Cash</span><strong>${money(cash)}</strong></div><div class="panel metric"><span>Card</span><strong>${money(card)}</strong></div><div class="panel metric"><span>Canceled</span><strong>${canceledToday.length}</strong></div></div><div class="panel" style="overflow:auto">${orders.length === 0 ? '<div class="empty-state">No completed or canceled orders yet.</div>' : `<table class="history-table"><thead><tr><th>Order</th><th>Items</th><th>Status</th><th>Payment</th><th>Total</th><th>Time</th></tr></thead><tbody>${orders.map(o => `<tr class="${o.status === 'canceled' ? 'canceled-row' : ''}"><td><strong>${orderNumber(o.orderNumber)}</strong></td><td>${o.items.map(i => `${i.quantity}× ${escapeHtml(i.name)}`).join('<br>')}${o.bundleDiscount > 0 ? `<br><small>Bundle discount: −${money(o.bundleDiscount)}</small>` : ''}</td><td><span class="status-pill ${o.status}">${o.status}</span></td><td>${escapeHtml(o.paymentMethod)}</td><td>${money(o.total)}</td><td>${new Date(o.completedAt || o.canceledAt || o.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</td></tr>`).join('')}</tbody></table>`}</div></section>`);
}

window.saveSettings = async () => {
  const business_name = document.getElementById('businessName').value.trim();
  const tax_enabled = document.getElementById('taxEnabled').checked;
  const tax_rate = Number(document.getElementById('taxRate').value);
  const { error } = await supabase.from('app_settings').update({ business_name, tax_enabled, tax_rate, updated_at: new Date().toISOString() }).eq('id', 1);
  showToast(error ? error.message : 'Settings saved.');
};
window.updatePrice = async (id, value) => {
  const { error } = await supabase.from('menu_items').update({ price: Number(value), updated_at: new Date().toISOString() }).eq('id', id);
  showToast(error ? error.message : 'Price updated.');
};
window.toggleSoldOut = async (id, soldOut) => {
  const { error } = await supabase.from('menu_items').update({ sold_out: soldOut, updated_at: new Date().toISOString() }).eq('id', id);
  showToast(error ? error.message : (soldOut ? 'Item marked sold out.' : 'Item restored.'));
};
window.resetOrderNumbers = async () => {
  if (!confirm('Reset the sequence safely? Existing orders remain saved.')) return;
  const { error } = await supabase.rpc('reset_pos_order_numbers');
  showToast(error ? error.message : 'Order number sequence checked.');
};
window.clearAllHistory = async () => {
  const confirmation = prompt('This permanently deletes all orders and sales history.\n\nType RESET to continue.');
  if (confirmation === null) return;
  if (confirmation !== 'RESET') return showToast('History was not cleared. You must type RESET exactly.');
  const { error } = await supabase.rpc('clear_pos_history', { p_confirmation: confirmation });
  if (error) return showToast(error.message);
  showToast('All order history and sales data were cleared.');
  location.hash = 'history';
};

function renderSettings() {
  renderShell(`<div class="settings-grid"><section class="panel settings-card"><h2>Business Settings</h2><div class="setting-row"><label>Business name</label><input id="businessName" class="text-input" value="${escapeHtml(state.settings.businessName)}"></div><div class="setting-row"><label><input id="taxEnabled" type="checkbox" ${state.settings.taxEnabled ? 'checked' : ''}> Enable tax</label></div><div class="setting-row"><label>Tax rate (%)</label><input id="taxRate" class="text-input" type="number" min="0" step="0.01" value="${state.settings.taxRate}"></div><div class="notice"><strong>Bundle rule:</strong> Every 5 Bungeoppang receives a $2.50 discount, making 5 regular pieces $15. Premium flavours remain +$0.50 each.</div><button class="primary" onclick="saveSettings()">Save Settings</button><button class="secondary danger" style="width:100%;margin-top:10px" onclick="resetOrderNumbers()">Check / Reset Order Sequence</button><button class="secondary danger" style="width:100%;margin-top:10px" onclick="clearAllHistory()">Clear All Order History</button></section><section class="panel settings-card"><h2>Menu Availability and Prices</h2>${state.menu.map(i => `<div class="menu-setting-row"><div><strong>${escapeHtml(i.name)}</strong><br><small>${escapeHtml(i.category)}</small></div><input class="text-input" type="number" min="0" step="0.01" value="${i.price}" onchange="updatePrice('${i.id}',this.value)"><button class="toggle ${i.soldOut ? 'sold' : 'available'}" onclick="toggleSoldOut('${i.id}',${!i.soldOut})">${i.soldOut ? 'Sold Out' : 'Available'}</button></div>`).join('')}</section></div>`);
}

setInterval(() => {
  if (route === 'prep-bungeoppang' || route === 'prep-bingsu') render();
}, 15000);

async function init() {
  await loadState();
  subscribeRealtime();
}
init();
