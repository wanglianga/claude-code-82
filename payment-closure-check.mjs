// 闭池退款/补偿券按原支付渠道分别处理 专项验收
const BASE = process.env.TARGET || 'http://host.docker.internal:3082/api';
let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name} ${extra}`); }
}
async function api(path, token, body, method = 'POST') {
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (e) { return { status: 0, data: { error: e.message } }; }
}
const login = async (u) => (await api('/auth/login', null, { username: u, password: '123456' })).data.token;
const ops = await login('ops'), zhang = await login('zhang'), zhao = await login('zhao');
const li = await login('li'), cl = await login('cleaner'), mt = await login('maintenance');
const state = async (tok) => (await api('/state', tok, undefined, 'GET')).data;
const me = async (tok) => (await api('/me', tok, undefined, 'GET')).data.user;

// 播种数据（s-mid 受影响预约）：
//  B-2061 张为民 储值 25（已入场）、B-2065 张为民 补偿券 25、B-2064 赵晓 现场 45、B-2062 李娟 储值 40
console.log('① 闭池前各渠道余额基线');
const z0 = await me(zhang), zh0 = await me(zhao), l0 = await me(li);
check('张为民初始储值 320', z0.walletBalance === 320, `=${z0.walletBalance}`);
check('张为民补偿券已被 B-2065 消耗为 0', z0.compVouchers === 0, `=${z0.compVouchers}`);
check('访客赵晓储值为 0（现场支付）', zh0.walletBalance === 0);

console.log('② 第一轮闭池（退款开、额外补偿券关、通知开、需复测）');
let r = await api('/pool-status', ops, {
  sessionId: 's-mid', status: 'closed', cause: 'thunderstorm',
  reason: '雷雨临近闭池-渠道退款验收', refund: true, compVoucher: false, notifyResidents: true, requireWaterRetest: true,
});
check('闭池成功', r.status === 200, JSON.stringify(r.data));
let st = await state(ops);
let rec = st.closureRecords.find((x) => x.sessionId === 's-mid' && x.seq === 1);

console.log('③ 运营档案按渠道分别汇总');
check('储值退款合计 65（张25+李40）', rec.walletRefundTotal === 65 && rec.walletRefundCount === 2, `=${rec.walletRefundTotal}/${rec.walletRefundCount}`);
check('现场退款登记 45 一笔（赵晓）', rec.cashRefundTotal === 45 && rec.cashRefundCount === 1, `=${rec.cashRefundTotal}/${rec.cashRefundCount}`);
check('原券返还 1 张（B-2065）', rec.originalVoucherReturnCount === 1, `=${rec.originalVoucherReturnCount}`);
check('额外补偿券 0 张', rec.extraVoucherCount === 0);
check('档案不设旧的混记字段 refundTotal', rec.refundTotal === undefined);

console.log('④ 张为民：储值仅 +25，补偿券仅恢复原 1 张');
const z1 = await me(zhang);
check('储值余额 345（仅储值预约退款，券预约不加钱）', z1.walletBalance === 345, `=${z1.walletBalance}`);
check('补偿券恢复为 1（原券返还，非额外补偿）', z1.compVouchers === 1, `=${z1.compVouchers}`);
const stZhang = await state(zhang);
const closureTxns = stZhang.walletTxns.filter((t) => t.closureId === rec.id);
check('本轮仅产生 1 笔闭池钱包流水（+25 储值退款）', closureTxns.length === 1 && closureTxns[0].amount === 25, `n=${closureTxns.length}`);
check('券预约 B-2065 不产生任何钱包流水', !stZhang.walletTxns.some((t) => t.closureId === rec.id && t.amount !== 25));

console.log('⑤ 赵晓（现场支付）：储值不变，保留现场退款处理说明');
const zh1 = await me(zhao);
check('赵晓储值仍为 0（现场支付未被写成钱包退款）', zh1.walletBalance === 0, `=${zh1.walletBalance}`);
const cashItem = rec.affected.find((a) => a.bookingCode === 'B-2064');
check('档案记录现场退款渠道与说明', cashItem.refund?.channel === 'cash' && cashItem.refund.amount === 45 && /前台/.test(cashItem.refund.note || ''), JSON.stringify(cashItem.refund));
const stZhao = await state(zhao);
check('赵晓无闭池钱包流水', !stZhao.walletTxns.some((t) => t.closureId === rec.id));

console.log('⑥ 逐人通知口径与渠道一致（不再错误宣称退回账户）');
// 张为民一人有储值+券两笔：合并为一条个人通知，其中两个渠道分别正确表述
const personalNotes = stZhang.notifications.filter((n) => n.closureId === rec.id && n.userId === 'u-zhang');
check('张为民只收到一条合并个人通知（不重复）', personalNotes.length === 1, `n=${personalNotes.length}`);
const merged = personalNotes[0]?.body || '';
check('券预约部分说明“原补偿券已返还”，不宣称退钱', /B-2065[^。]*补偿券已返还/.test(merged) && !/B-2065[^。]*元/.test(merged), merged);
check('储值预约部分说明 25 元退回储值余额', /B-2061[^。]*25 元已原路退回您的储值余额/.test(merged), merged);
check('张为民看不到李娟的逐人退款通知（个人通知不广播）', !stZhang.notifications.some((n) => n.closureId === rec.id && n.userId === 'u-li'),
  JSON.stringify(stZhang.notifications.filter(n => n.closureId === rec.id).map(n => n.userId)));
const zhaoNote = (await state(zhao)).notifications.find((n) => n.closureId === rec.id && (n.body || '').includes('现场退款'));
check('现场支付通知为前台办理说明，不宣称入储值', !!zhaoNote && /不退入储值|现场退款/.test(zhaoNote.body || ''), zhaoNote?.body);
const cashNoteOps = st.notifications.find((n) => n.closureId === rec.id && n.roles.includes('frontdesk') === false && (n.title || '').includes('闭池·'));
check('全员公告含三类渠道分别统计', !!cashNoteOps && /储值退款 2 笔/.test(cashNoteOps.body) && /原券返还 1 张/.test(cashNoteOps.body) && /现场退款登记 1 笔/.test(cashNoteOps.body), cashNoteOps?.body);

console.log('⑦ 完成本轮处置并恢复开放');
for (const tid of rec.taskIds) {
  const t = st.workTasks.find((x) => x.id === tid);
  const tok = t.assigneeRole === 'cleaner' ? cl : mt;
  await api(`/tasks/${tid}/claim`, tok, {});
  const d = await api(`/tasks/${tid}/done`, tok, { result: `${t.kind}完成` });
  check(`工单 ${t.kind} 完成`, d.status === 200, d.data.error);
}
r = await api('/water', mt, { sessionId: 's-mid', tempC: 27, freeChlorine: 0.8, turbidity: 0.5, ph: 7.3, note: '第一轮复测' });
check('第一轮复测达标', r.status === 201 && r.data.abnormal === false);
r = await api('/pool-status', ops, { sessionId: 's-mid', status: 'normal' });
check('第一轮恢复开放', r.status === 200, r.data.error);

console.log('⑧ 第二轮闭池（勾选额外补偿券）：原券返还与额外补偿分开可追溯');
// 张为民用恢复后的 1 张券再约一笔
r = await api('/bookings', zhang, {
  kind: 'personal', sessionId: 's-mid', zoneId: 'deep', age: 42, healthPledge: true,
  withChildren: false, childCount: 0, swimLevel: 'advanced', paymentMethod: 'voucher',
});
check('张为民用券重新预约深水区', r.status === 201, r.data?.error);
const zBetween = await me(zhang);
check('用券后余额不变、券为 0', zBetween.walletBalance === 345 && zBetween.compVouchers === 0, `bal=${zBetween.walletBalance} v=${zBetween.compVouchers}`);

r = await api('/pool-status', ops, {
  sessionId: 's-mid', status: 'closed', cause: 'water_abnormal',
  reason: '水质异常二次闭池-额外补偿验收', refund: true, compVoucher: true, notifyResidents: true, requireWaterRetest: true,
});
check('第二轮闭池成功', r.status === 200, r.data?.error);
st = await state(ops);
const rec2 = st.closureRecords.find((x) => x.sessionId === 's-mid' && x.seq === 2);
check('第二轮原券返还 1 张', rec2.originalVoucherReturnCount === 1, `=${rec2.originalVoucherReturnCount}`);
check('第二轮额外补偿券单独计数 ≥1', rec2.extraVoucherCount >= 1, `=${rec2.extraVoucherCount}`);
const z2Item = rec2.affected.find((a) => a.userId === 'u-zhang');
check('张为民该笔：原券返还与额外补偿在档案中分开记录',
  z2Item.refund?.channel === 'voucher' && z2Item.refund.returnedCount === 1 && z2Item.extraCompVoucher === true,
  JSON.stringify(z2Item));
const z2 = await me(zhang);
check('张为民最终：储值仍 345（第二轮券预约不加钱），券=原券返还1+额外补偿1=2', z2.walletBalance === 345 && z2.compVouchers === 2, `bal=${z2.walletBalance} v=${z2.compVouchers}`);
const stZ2 = await state(zhang);
check('第二轮无任何闭池钱包流水（券预约只返券）', !stZ2.walletTxns.some((t) => t.closureId === rec2.id), JSON.stringify(stZ2.walletTxns.filter(t => t.closureId)));
const extraNote = stZ2.notifications.find((n) => n.closureId === rec2.id && n.userId === 'u-zhang');
check('通知中原券返还与额外补偿券为两句分开表述',
  !!extraNote && /原预约使用的 1 张补偿券已返还/.test(extraNote.body || '') && /额外发放 1 张补偿券/.test(extraNote.body || ''), extraNote?.body);

console.log('⑨ 首轮档案历史不被第二轮改变');
const rec1After = st.closureRecords.find((x) => x.id === rec.id);
check('首轮仍为雷雨、额外补偿 0、储值退款 65', rec1After.cause === 'thunderstorm' && rec1After.extraVoucherCount === 0 && rec1After.walletRefundTotal === 65);
check('首轮受影响明细数不变', rec1After.affected.length === rec.affected.length);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('失败项：', fails); process.exit(1); }
