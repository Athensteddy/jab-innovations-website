let products=[],editingId=null;const $=s=>document.querySelector(s),money=n=>'$'+Number(n||0).toFixed(2);async function api(u,o={}){const r=await fetch(u,{...o,headers:{'content-type':'application/json',...(o.headers||{})}}),d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Request failed');return d}async function load(){products=await api('/api/products');render()}function render(){const active=products.filter(p=>+p.active===1).length,total=products.reduce((a,p)=>a+ +p.quantity,0),low=products.filter(p=>+p.active===1&&+p.quantity<=+p.low_stock).length,value=products.reduce((a,p)=>a+(+p.cost*+p.quantity),0);$('#stats').innerHTML=[['Active Products',active],['Total Inventory',total],['Low Stock',low],['Inventory Cost',money(value)]].map(x=>`<div class="stat"><span class="muted">${x[0]}</span><strong>${x[1]}</strong></div>`).join('');$('#rows').innerHTML=products.map(p=>`<tr><td><strong>${p.name}</strong><br><span class="muted">${p.category}</span></td><td><input class="inline-input" id="cost-${p.id}" type="number" min="0" step=".01" value="${p.cost}"></td><td><input class="inline-input" id="price-${p.id}" type="number" min="0" step=".01" value="${p.price}"></td><td><input class="inline-input" id="qty-${p.id}" type="number" min="0" value="${p.quantity}"></td><td><input id="active-${p.id}" type="checkbox" ${+p.active===1?'checked':''}></td><td><button class="btn" onclick="quickSave('${p.id}')">Save</button> <button class="btn secondary" onclick="openModal(products.find(x=>x.id==='${p.id}'))">Details</button> <button class="btn danger" onclick="removeProduct('${p.id}')">Delete</button></td></tr>`).join('')}async function quickSave(id){const p=products.find(x=>x.id===id),b={...p,cost:+$(`#cost-${id}`).value,price:+$(`#price-${id}`).value,quantity:+$(`#qty-${id}`).value,active:$(`#active-${id}`).checked};await api('/api/products/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify(b)});toast('Saved permanently');await load()}function openModal(p=null){editingId=p?.id||null;$('#modalTitle').textContent=p?'Edit Product':'Add Product';['name','category','cost','price','quantity','low_stock','image_url','description'].forEach(k=>$('#'+k).value=p?.[k]??'');$('#active').checked=p?+p.active===1:true;$('#modal').classList.add('open')}function closeModal(){$('#modal').classList.remove('open')}async function submitProduct(e){e.preventDefault();const b={name:$('#name').value,category:$('#category').value,cost:+$('#cost').value,price:+$('#price').value,quantity:+$('#quantity').value,low_stock:+$('#low_stock').value,image_url:$('#image_url').value,description:$('#description').value,active:$('#active').checked};await api(editingId?'/api/products/'+encodeURIComponent(editingId):'/api/products',{method:editingId?'PUT':'POST',body:JSON.stringify(b)});closeModal();toast('Product saved');await load()}async function removeProduct(id){if(!confirm('Delete this product permanently?'))return;await api('/api/products/'+encodeURIComponent(id),{method:'DELETE'});await load()}function toast(m){$('#toast').textContent=m;$('#toast').classList.add('show');setTimeout(()=>$('#toast').classList.remove('show'),1800)}load().catch(e=>$('#error').textContent=e.message)// =========================
// COA MANAGER
// =========================

let coas = [];

function openCoaModal() {
  $('#coaModal').classList.add('open');
}

function closeCoaModal() {
  $('#coaModal').classList.remove('open');
  $('#coaForm').reset();
  $('#coa_active').checked = true;
  $('#coaUploadStatus').textContent = '';
}

async function loadCoas() {
  try {
    coas = await api('/api/coas');
    renderCoas();
  } catch (e) {
    $('#coaError').textContent = e.message;
  }
}

function renderCoas() {
  const rows = $('#coaRows');

  if (!coas.length) {
    rows.innerHTML = `
      <tr>
        <td colspan="6" class="muted">
          No COAs uploaded yet.
        </td>
      </tr>
    `;
    return;
  }

  rows.innerHTML = coas.map(c => `
    <tr>
      <td><strong>${c.product_name || ''}</strong></td>
      <td>${c.batch_lot || ''}</td>
      <td>${c.lab || ''}</td>
      <td>${c.test_date || ''}</td>
      <td>
        <a class="btn secondary"
           href="/api/coas/${encodeURIComponent(c.id)}/file"
           target="_blank">
          View
        </a>
      </td>
      <td>
        <button class="btn danger"
                onclick="removeCoa('${c.id}')">
          Delete
        </button>
      </td>
    </tr>
  `).join('');
}

async function submitCoa(e) {
  e.preventDefault();

  const file = $('#coa_file').files[0];

  if (!file) {
    $('#coaUploadStatus').textContent = 'Please choose a PDF or image.';
    return;
  }

  $('#coaUploadStatus').textContent = 'Uploading...';

  const form = new FormData();
  form.append('product_name', $('#coa_product').value);
  form.append('batch_lot', $('#coa_batch').value);
  form.append('lab', $('#coa_lab').value);
  form.append('test_date', $('#coa_test_date').value);
  form.append('active', $('#coa_active').checked ? '1' : '0');
  form.append('file', file);

  try {
    const r = await fetch('/api/coas', {
      method: 'POST',
      body: form
    });

    const d = await r.json().catch(() => ({}));

    if (!r.ok) {
      throw new Error(d.error || 'COA upload failed');
    }

    closeCoaModal();
    toast('COA uploaded');
    await loadCoas();

  } catch (e) {
    $('#coaUploadStatus').textContent = e.message;
  }
}

async function removeCoa(id) {
  if (!confirm('Delete this COA permanently?')) return;

  await api('/api/coas/' + encodeURIComponent(id), {
    method: 'DELETE'
  });

  toast('COA deleted');
  await loadCoas();
}

loadCoas();

// =========================
// CUSTOMER ORDERS (READ-ONLY)
// =========================
// =========================
// CUSTOMER ORDERS
// =========================

let adminOrders = [];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

async function confirmOrder(id) {
  if (!confirm('Confirm this order?')) return;

  try {
    await api('/api/admin/orders/' + encodeURIComponent(id) + '/confirm', {
      method: 'POST',
      body: JSON.stringify({})
    });

    toast('Order confirmed');
    await loadAdminOrders();

  } catch (e) {
    $('#orderError').textContent = e.message;
  }
}

async function shipOrder(id) {
  const carrier = prompt('Carrier (USPS, UPS, FedEx, etc.):');
  if (!carrier) return;

  const tracking = prompt('Tracking number:');
  if (!tracking) return;

  try {
    await api('/api/admin/orders/' + encodeURIComponent(id) + '/ship', {
      method: 'POST',
      body: JSON.stringify({
        carrier: carrier,
        tracking_number: tracking
      })
    });

    toast('Order marked shipped');
    await loadAdminOrders();

  } catch (e) {
    $('#orderError').textContent = e.message;
  }
}

async function loadAdminOrders() {
  try {
    $('#orderError').textContent = '';

    adminOrders = await api('/api/admin/orders');

    const rows = $('#orderRows');

    if (!adminOrders.length) {
      rows.innerHTML =
        '<tr><td colspan="7" class="muted">No customer orders yet.</td></tr>';
      return;
    }

    rows.innerHTML = adminOrders.map(o => {

      const items = (o.items || [])
        .map(i =>
          `${esc(i.product_name)} × ${Number(i.quantity || 0)}`
        )
        .join('<br>');

      const when = o.created_at
        ? new Date(o.created_at + 'Z').toLocaleString()
        : '';

      let actions = '';

      if (o.status !== 'confirmed' && o.status !== 'shipped') {
        actions += `
          <button class="btn"
                  onclick="confirmOrder('${o.id}')">
            Confirm
          </button>
        `;
      }

      if (o.status !== 'shipped') {
        actions += `
          <button class="btn secondary"
                  onclick="shipOrder('${o.id}')">
            Ship + Tracking
          </button>
        `;
      }

      let tracking = '';

      if (o.tracking_number) {
        tracking = `
          <br>
          <span class="muted">
            ${esc(o.carrier || '')}<br>
            ${esc(o.tracking_number)}
          </span>
        `;
      }

      return `
        <tr>

          <td>
            <strong>${esc(o.order_number)}</strong><br>
            <span class="muted">${esc(o.status)}</span>
            ${tracking}
          </td>

          <td>
            <strong>${esc(o.customer_name)}</strong><br>
            ${esc(o.customer_email)}<br>
            <span class="muted">
              ${esc(o.customer_phone || '')}
            </span>
          </td>

          <td>
            ${items}
          </td>

          <td>
            <strong>${money(o.total)}</strong>
          </td>

          <td>
            ${esc(o.payment_status)}
          </td>

          <td>
            ${esc(when)}
          </td>

          <td>
            ${actions}
          </td>

        </tr>
      `;

    }).join('');

  } catch (e) {
    $('#orderError').textContent = e.message;
  }
}

loadAdminOrders();
