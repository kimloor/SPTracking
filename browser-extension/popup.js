document.addEventListener('DOMContentLoaded', async () => {
  const { latest_capture: capture, latest_capture_status: status } = await chrome.storage.local.get([
    'latest_capture',
    'latest_capture_status'
  ]);

  const statusEl = document.getElementById('status');
  const dataEl = document.getElementById('data');

  if (!capture) {
    statusEl.textContent = 'ยังไม่พบ capture จากหน้าสินค้า Shopee';
    return;
  }

  const stateText = {
    sending: 'กำลังส่งข้อมูลไป SPTracking',
    accepted: 'ส่งข้อมูลสำเร็จ',
    failed: 'ส่งข้อมูลไม่สำเร็จ'
  }[status?.state] || 'พบข้อมูลสินค้าแล้ว';

  statusEl.textContent = `${stateText}${status?.http_status ? ` (HTTP ${status.http_status})` : ''}`;

  const rows = [
    ['สินค้า', capture.product_name],
    ['รุ่น', capture.variation_name],
    ['ราคา', capture.price != null ? `฿${Number(capture.price).toLocaleString('th-TH')}` : null],
    ['ราคาเดิม', capture.original_price != null ? `฿${Number(capture.original_price).toLocaleString('th-TH')}` : null],
    ['สต็อก', capture.stock],
    ['shop_id', capture.shop_id],
    ['item_id', capture.item_id],
    ['model_id', capture.model_id],
    ['เวลา', capture.captured_at || capture.captured_at_client]
  ];

  for (const [label, value] of rows) {
    if (value === null || value === undefined || value === '') continue;
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = String(value);
    dataEl.append(dt, dd);
  }

  if (status?.error) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = 'Error';
    dd.textContent = status.error;
    dataEl.append(dt, dd);
  }
});
