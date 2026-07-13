import { createClient } from '@supabase/supabase-js';
import './styles.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const app = document.getElementById('app');

if (!supabaseUrl || !supabaseKey) {
  app.innerHTML = `<main class="page"><section class="panel checkout-card"><h2>Supabase setup required</h2><p>Create a <code>.env</code> file locally or add the Netlify environment variables:</p><pre>VITE_SUPABASE_URL=...\nVITE_SUPABASE_ANON_KEY=...</pre></section></main>`;
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
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function cartSubtotal() { return cart.reduce((sum, item) => sum + item.price * item.quantity, 0); }
function cartTax() { return state.settings.taxEnabled ? cartSubtotal() * Number(state.settings.taxRate || 0) / 100 : 0; }
function cartTotal() { return cartSubtotal() + cartTax(); }
function cartCount() { return cart.reduce((sum, item) => sum + item.quantity, 0); }
function activeOrders() { return state.orders.filter(o => o.status === 'preparing').sort((a,b) => new Date(a.createdAt)-new Date(b.createdAt)); }
function completedOrders() { return state.orders.filter(o => o.status === 'completed').sort((a,b) => new Date(b.completedAt||b.createdAt)-new Date(a.completedAt||a.createdAt)); }

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
  state.menu = menuResult.data.map(i => ({ id:i.id, category:i.category, name:i.name, price:Number(i.price), soldOut:i.sold_out }));
  state.orders = ordersResult.data.map(o => ({
    id:o.id, orderNumber:Number(o.order_number), note:o.note, subtotal:Number(o.subtotal), taxRate:Number(o.tax_rate), tax:Number(o.tax), total:Number(o.total),
    paymentMethod:o.payment_method, cashReceived:o.cash_received === null ? null : Number(o.cash_received), status:o.status,
    createdAt:o.created_at, completedAt:o.completed_at,
    items:(o.order_items||[]).map(i => ({ name:i.name, category:i.category, unitPrice:Number(i.unit_price), quantity:i.quantity, lineTotal:Number(i.line_total) }))
  }));
  loading = false;
  render();
}

function subscribeRealtime() {
  const channel = supabase.channel('bingppang-pos-live')
    .on('postgres_changes', { event:'*', schema:'public', table:'orders' }, loadState)
    .on('postgres_changes', { event:'*', schema:'public', table:'order_items' }, loadState)
    .on('postgres_changes', { event:'*', schema:'public', table:'menu_items' }, loadState)
    .on('postgres_changes', { event:'*', schema:'public', table:'app_settings' }, loadState)
    .subscribe(status => {
      connectionStatus = status === 'SUBSCRIBED' ? 'live' : status.toLowerCase();
      render();
    });
  window.addEventListener('beforeunload', () => supabase.removeChannel(channel));
}

function showToast(message, actionLabel=null, action=null) {
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
  const navItems = [['pos','Cashier'],['prep',`Preparing (${activeOrders().length})`],['history','History'],['settings','Settings']];
  app.innerHTML = `<div class="app-shell"><header class="topbar"><div class="brand"><div class="brand-mark">🐟</div><div><h1>${escapeHtml(state.settings.businessName)} POS</h1><small>Booth ordering system · ${connectionStatus === 'live' ? 'Live' : 'Connecting…'}</small></div></div><nav class="nav">${navItems.map(([key,label])=>`<button class="${route===key || (route==='checkout'&&key==='pos')?'active':''}" onclick="location.hash='${key}'">${label}</button>`).join('')}</nav></header><main class="page">${loading?'<div class="panel empty-state">Loading…</div>':content}</main></div>`;
}

function render() {
  if (route==='prep') return renderPrep();
  if (route==='history') return renderHistory();
  if (route==='settings') return renderSettings();
  if (route==='checkout') return renderCheckout();
  renderPOS();
}

window.addToCart = id => {
  const item = state.menu.find(i=>i.id===id); if (!item || item.soldOut) return;
  const existing = cart.find(i=>i.menuItemId===id);
  if (existing) existing.quantity++; else cart.push({menuItemId:id,name:item.name,category:item.category,price:item.price,quantity:1});
  render();
};
window.changeQty = (id,delta) => { const item=cart.find(i=>i.menuItemId===id); if(!item)return; item.quantity+=delta; if(item.quantity<=0) cart=cart.filter(i=>i.menuItemId!==id); render(); };
window.setCategory = cat => { category=cat; render(); };
window.setOrderNote = value => { orderNote=value; };
window.clearCart = () => { cart=[]; orderNote=''; checkoutMode=null; cashReceived=''; render(); };

function renderPOS() {
  const items=state.menu.filter(i=>i.category===category);
  renderShell(`<div class="pos-grid"><section class="panel menu-panel"><div class="category-tabs">${['Bungeoppang','Bingsu'].map(cat=>`<button class="${category===cat?'active':''}" onclick="setCategory('${cat}')">${cat}</button>`).join('')}</div><div class="menu-grid">${items.map(item=>`<button class="menu-item ${item.soldOut?'sold-out':''}" ${item.soldOut?'disabled':''} onclick="addToCart('${item.id}')"><strong>${escapeHtml(item.name)}</strong><span>${money(item.price)}</span>${item.soldOut?'<span class="soldout-badge">SOLD OUT</span>':''}</button>`).join('')}</div></section><aside class="panel cart-panel"><h2 class="section-title">Current Order</h2>${cart.length===0?'<div class="cart-empty">Tap a menu item to begin.</div>':`<div class="cart-list">${cart.map(item=>`<div class="cart-row"><div><strong>${escapeHtml(item.name)}</strong><br><small>${escapeHtml(item.category)} · ${money(item.price)} each</small></div><div class="qty"><button onclick="changeQty('${item.menuItemId}',-1)">−</button><strong>${item.quantity}</strong><button onclick="changeQty('${item.menuItemId}',1)">+</button></div></div>`).join('')}</div><textarea class="note-input" placeholder="Optional order note" oninput="setOrderNote(this.value)">${escapeHtml(orderNote)}</textarea><div class="totals"><div class="total-line"><span>${cartCount()} items</span><strong>${money(cartSubtotal())}</strong></div><div class="total-line"><span>${state.settings.taxEnabled?`GST (${state.settings.taxRate}%)`:'Tax'}</span><strong>${money(cartTax())}</strong></div><div class="total-line grand"><span>Total</span><span>${money(cartTotal())}</span></div></div><button class="primary" onclick="location.hash='checkout'">Checkout</button><button class="secondary danger" style="width:100%;margin-top:8px" onclick="clearCart()">Clear order</button>`}</aside></div>`);
}

window.selectPayment = mode => { checkoutMode=mode; render(); };
window.setCashReceived = value => {
  cashReceived = value;
  const received = Number(cashReceived || 0);
  const total = cartTotal();
  const changeEl = document.getElementById('change-due');
  const submitBtn = document.getElementById('submit-order-btn');

  if (changeEl) changeEl.textContent = money(Math.max(0, received - total));
  if (submitBtn && checkoutMode === 'cash') submitBtn.disabled = received < total;
};
window.startNextOrder = () => { lastSubmittedOrder=null; location.hash='pos'; };

function renderCheckout() {
  if (cart.length===0 && !lastSubmittedOrder) { location.hash='pos'; return; }
  if (lastSubmittedOrder) return renderShell(`<section class="panel checkout-card"><div class="success-box"><h2>Order ${orderNumber(lastSubmittedOrder.orderNumber)} submitted</h2><p>It is now visible on the preparation screen.</p></div><button class="primary" onclick="startNextOrder()">Start Next Order</button></section>`);
  const total=cartTotal(), received=Number(cashReceived||0), change=Math.max(0,received-total);
  renderShell(`<section class="panel checkout-card"><h2>Checkout</h2><div class="totals"><div class="total-line"><span>Subtotal</span><strong>${money(cartSubtotal())}</strong></div><div class="total-line"><span>${state.settings.taxEnabled?`GST (${state.settings.taxRate}%)`:'Tax'}</span><strong>${money(cartTax())}</strong></div><div class="total-line grand"><span>Total</span><span>${money(total)}</span></div></div><div class="payment-options"><button class="payment-option ${checkoutMode==='cash'?'active':''}" onclick="selectPayment('cash')">Cash</button><button class="payment-option ${checkoutMode==='card'?'active':''}" onclick="selectPayment('card')">Card / Square</button></div>${checkoutMode==='cash'?`<label>Cash received<input class="money-input" inputmode="decimal" value="${escapeHtml(cashReceived)}" oninput="setCashReceived(this.value)" placeholder="0.00"></label><div class="quick-cash"><button onclick="setCashReceived('${total.toFixed(2)}')">Exact</button>${[20,50,100].map(v=>`<button onclick="setCashReceived('${v}')">${money(v)}</button>`).join('')}</div><div class="notice"><strong>Change due: <span id="change-due">${money(change)}</span></strong></div>`:''}${checkoutMode==='card'?`<div class="notice">Open Square and charge <strong>${money(total)}</strong>. Return only after payment succeeds.</div>`:''}<button id="submit-order-btn" class="primary" ${!checkoutMode||(checkoutMode==='cash'&&received<total)?'disabled':''} onclick="submitOrder()">Payment Received — Submit Order</button><button class="secondary" style="width:100%;margin-top:8px" onclick="location.hash='pos'">Back to Order</button></section>`);
}

window.submitOrder = async () => {
  const { data, error } = await supabase.rpc('create_pos_order', {
    p_items: cart.map(i=>({menu_item_id:i.menuItemId,quantity:i.quantity})),
    p_note: orderNote,
    p_payment_method: checkoutMode,
    p_cash_received: checkoutMode==='cash'?Number(cashReceived):null
  });
  if (error) return showToast(error.message);
  await loadState();
  const order=state.orders.find(o=>o.id===data);
  lastSubmittedOrder=order || {orderNumber:'?'};
  cart=[]; orderNote=''; checkoutMode=null; cashReceived=''; render();
};

function elapsed(iso) { const s=Math.max(0,Math.floor((Date.now()-new Date(iso))/1000)); if(s<60)return`${s}s ago`; const m=Math.floor(s/60); if(m<60)return`${m}m ago`; return`${Math.floor(m/60)}h ${m%60}m ago`; }
window.completeOrder = async (id,number) => { const {error}=await supabase.rpc('complete_pos_order',{p_order_id:id}); if(error)return showToast(error.message); showToast(`Order ${orderNumber(number)} completed.`,'Undo',async()=>{await supabase.rpc('reopen_pos_order',{p_order_id:id});}); };

function renderPrep() {
  const orders=activeOrders();
  renderShell(`<section><h2>Preparing Orders</h2>${orders.length===0?'<div class="panel empty-state"><h3>No active orders</h3><p>Paid orders will appear here automatically.</p></div>':`<div class="orders-grid">${orders.map(order=>`<article class="panel order-card"><header><div class="order-number">${orderNumber(order.orderNumber)}</div><div class="order-time">${elapsed(order.createdAt)}</div></header><div class="order-items">${order.items.map(i=>`<div class="order-item-line"><strong>${i.quantity} × ${escapeHtml(i.name)}</strong><small>${escapeHtml(i.category)}</small></div>`).join('')}</div>${order.note?`<div class="order-note"><strong>Note:</strong> ${escapeHtml(order.note)}</div>`:''}<div class="total-line" style="margin:10px 0"><span>Paid by ${escapeHtml(order.paymentMethod)}</span><strong>${money(order.total)}</strong></div><button class="complete-btn" onclick="completeOrder('${order.id}',${order.orderNumber})">Complete Order</button></article>`).join('')}</div>`}</section>`);
}

function todayOrders(){const today=new Date().toDateString();return state.orders.filter(o=>new Date(o.createdAt).toDateString()===today);}
function renderHistory(){const orders=completedOrders(),today=todayOrders(),sales=today.reduce((s,o)=>s+o.total,0),cash=today.filter(o=>o.paymentMethod==='cash').reduce((s,o)=>s+o.total,0),card=today.filter(o=>o.paymentMethod==='card').reduce((s,o)=>s+o.total,0);renderShell(`<section><div class="metrics"><div class="panel metric"><span>Today's sales</span><strong>${money(sales)}</strong></div><div class="panel metric"><span>Orders</span><strong>${today.length}</strong></div><div class="panel metric"><span>Cash</span><strong>${money(cash)}</strong></div><div class="panel metric"><span>Card</span><strong>${money(card)}</strong></div></div><div class="panel" style="overflow:auto">${orders.length===0?'<div class="empty-state">No completed orders yet.</div>':`<table class="history-table"><thead><tr><th>Order</th><th>Items</th><th>Payment</th><th>Total</th><th>Completed</th></tr></thead><tbody>${orders.map(o=>`<tr><td><strong>${orderNumber(o.orderNumber)}</strong></td><td>${o.items.map(i=>`${i.quantity}× ${escapeHtml(i.name)}`).join('<br>')}</td><td>${escapeHtml(o.paymentMethod)}</td><td>${money(o.total)}</td><td>${new Date(o.completedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</td></tr>`).join('')}</tbody></table>`}</div></section>`);}

window.saveSettings = async () => { const business_name=document.getElementById('businessName').value.trim(),tax_enabled=document.getElementById('taxEnabled').checked,tax_rate=Number(document.getElementById('taxRate').value); const {error}=await supabase.from('app_settings').update({business_name,tax_enabled,tax_rate,updated_at:new Date().toISOString()}).eq('id',1); showToast(error?error.message:'Settings saved.'); };
window.updatePrice = async (id,value) => { const {error}=await supabase.from('menu_items').update({price:Number(value),updated_at:new Date().toISOString()}).eq('id',id); showToast(error?error.message:'Price updated.'); };
window.toggleSoldOut = async (id,soldOut) => { const {error}=await supabase.from('menu_items').update({sold_out:soldOut,updated_at:new Date().toISOString()}).eq('id',id); showToast(error?error.message:(soldOut?'Item marked sold out.':'Item restored.')); };
window.resetOrderNumbers = async () => { if(!confirm('Reset the sequence safely? Existing orders remain saved.'))return; const {error}=await supabase.rpc('reset_pos_order_numbers'); showToast(error?error.message:'Order number sequence checked.'); };
window.clearAllHistory = async () => { const confirmation=prompt('This permanently deletes all orders and sales history.\n\nType RESET to continue.'); if(confirmation===null)return; if(confirmation!=='RESET')return showToast('History was not cleared. You must type RESET exactly.'); const {error}=await supabase.rpc('clear_pos_history',{p_confirmation:confirmation}); if(error)return showToast(error.message); showToast('All order history and sales data were cleared.'); location.hash='history'; };

function renderSettings(){renderShell(`<div class="settings-grid"><section class="panel settings-card"><h2>Business Settings</h2><div class="setting-row"><label>Business name</label><input id="businessName" class="text-input" value="${escapeHtml(state.settings.businessName)}"></div><div class="setting-row"><label><input id="taxEnabled" type="checkbox" ${state.settings.taxEnabled?'checked':''}> Enable tax</label></div><div class="setting-row"><label>Tax rate (%)</label><input id="taxRate" class="text-input" type="number" min="0" step="0.01" value="${state.settings.taxRate}"></div><button class="primary" onclick="saveSettings()">Save Settings</button><button class="secondary danger" style="width:100%;margin-top:10px" onclick="resetOrderNumbers()">Check / Reset Order Sequence</button><button class="secondary danger" style="width:100%;margin-top:10px" onclick="clearAllHistory()">Clear All Order History</button></section><section class="panel settings-card"><h2>Menu Availability and Prices</h2>${state.menu.map(i=>`<div class="menu-setting-row"><div><strong>${escapeHtml(i.name)}</strong><br><small>${escapeHtml(i.category)}</small></div><input class="text-input" type="number" min="0" step="0.01" value="${i.price}" onchange="updatePrice('${i.id}',this.value)"><button class="toggle ${i.soldOut?'sold':'available'}" onclick="toggleSoldOut('${i.id}',${!i.soldOut})">${i.soldOut?'Sold Out':'Available'}</button></div>`).join('')}</section></div>`);}

setInterval(()=>{if(route==='prep')render();},15000);
async function init(){ await loadState(); subscribeRealtime(); }
init();
