// 闭池处置档案不可变 + 同场次多次闭池 专项验收
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
const ops = await login('ops');
const li = await login('li');
const mt = await login('maintenance');
const state = async (tok) => (await api('/state', tok, undefined, 'GET')).data;

console.log('① 第一轮：雷雨闭池（退费+补偿券+通知+复测要求）');
const liWalletBefore = (await state(li)).users.length; // residents users=[]; use /me for wallet
const meBefore = (await api('/me', li, undefined, 'GET')).data.user;
let r = await api('/pool-status', ops, {
  sessionId: 's-mid', status: 'closed', cause: 'thunderstorm',
  reason: '雷电黄色预警，雷雨临近临时闭池',
  refund: true, compVoucher: true, notifyResidents: true, requireWaterRetest: true,
});
check('第一轮闭池成功', r.status === 200, JSON.stringify(r.data));
let st = await state(ops);
let recs = st.closureRecords.filter((x) => x.sessionId === 's-mid').sort((a, b) => a.seq - b.seq);
check('生成 1 份闭池档案', recs.length === 1);
const rec1 = recs[0];
check('档案序号=1', rec1.seq === 1);
check('档案原因固化为雷雨', rec1.cause === 'thunderstorm' && rec1.reason.includes('雷电'));
check('档案含退费/补偿结果', rec1.refundCount >= 1 && rec1.voucherCount >= 1 && rec1.refundTotal > 0, JSON.stringify({ c: rec1.refundCount, v: rec1.voucherCount, t: rec1.refundTotal }));
check('档案含逐人受影响快照', rec1.affected.length >= 1 && rec1.affected.every((a) => a.bookingCode && a.paymentMethod));
check('档案关联清场/复测工单', rec1.taskIds.length === 2);
check('档案关联通知', rec1.announcementIds.length >= 2);
check('场次指向当前生效档案', st.sessions.find((s) => s.id === 's-mid').activeClosureId === rec1.id);
check('钱包流水引用闭池档案 id', st.walletTxns.some((t) => t.closureId === rec1.id && t.amount > 0));
const rec1Snapshot = JSON.stringify({
  id: rec1.id, seq: rec1.seq, cause: rec1.cause, reason: rec1.reason,
  closedAt: rec1.closedAt, closedBy: rec1.closedBy, options: rec1.options,
  affected: rec1.affected, refundTotal: rec1.refundTotal, refundCount: rec1.refundCount,
  voucherCount: rec1.voucherCount, taskIds: rec1.taskIds, announcementIds: rec1.announcementIds,
  guardReliefCount: rec1.guardReliefCount, incidentIds: rec1.incidentIds,
});

console.log('② 无复测不能恢复 → 维修复测达标 → 恢复');
r = await api('/pool-status', ops, { sessionId: 's-mid', status: 'normal' });
check('未复测拒绝恢复', r.status === 409);
r = await api('/water', mt, { sessionId: 's-mid', tempC: 27, freeChlorine: 0.8, turbidity: 0.5, ph: 7.3, note: '雷雨后复测' });
check('维修提交达标复测', r.status === 201 && r.data.abnormal === false);
r = await api('/pool-status', ops, { sessionId: 's-mid', status: 'normal' });
check('恢复开放成功', r.status === 200 && r.data.reopened === true);
st = await state(ops);
let rec1After = st.closureRecords.find((x) => x.id === rec1.id);
check('第一轮档案状态=已恢复且记录复测依据', rec1After.status === 'reopened' && !!rec1After.reopenedAt && !!rec1After.retestReadingId);
check('场次当前开放、生效档案已清空', st.sessions.find((s) => s.id === 's-mid').poolStatus === 'normal' && !st.sessions.find((s) => s.id === 's-mid').activeClosureId);

console.log('③ 恢复后居民重新预约，第二轮：水质异常闭池');
const liMe = (await api('/me', li, undefined, 'GET')).data.user;
check('居民看到第一轮退费到账', liMe.walletBalance > meBefore.walletBalance, `${meBefore.walletBalance} -> ${liMe.walletBalance}`);
r = await api('/bookings', li, {
  kind: 'personal', sessionId: 's-mid', zoneId: 'training', lane: 3,
  age: 35, healthPledge: true, healthCode: 'green', withChildren: false, childCount: 0,
  swimLevel: 'intermediate', paymentMethod: 'wallet',
});
check('恢复后居民可重新预约', r.status === 201, JSON.stringify(r.data?.error || r.status));
const newBookingId = r.data.booking?.id;

r = await api('/pool-status', ops, {
  sessionId: 's-mid', status: 'closed', cause: 'water_abnormal',
  reason: '余氯 0.15 偏低、浊度超标，水质异常闭池',
  refund: true, compVoucher: true, notifyResidents: true, requireWaterRetest: true,
});
check('第二轮闭池成功', r.status === 200, JSON.stringify(r.data));
st = await state(ops);
recs = st.closureRecords.filter((x) => x.sessionId === 's-mid').sort((a, b) => a.seq - b.seq);
check('同场次存在 2 份闭池档案', recs.length === 2, `len=${recs.length}`);
const rec2 = recs[1];
check('第二份序号=2、原因为水质', rec2.seq === 2 && rec2.cause === 'water_abnormal' && rec2.reason.includes('余氯'));
check('第二份包含新一轮受影响预约（含恢复后新预约）', rec2.affected.some((a) => a.bookingId === newBookingId));

console.log('④ 首轮档案不被覆盖');
check('第一轮档案序号仍为 1', recs[0].seq === 1);
check('第一轮原因仍是雷雨（未被水质覆盖）', recs[0].reason.includes('雷电') && recs[0].cause === 'thunderstorm');
check('第一轮仍是已恢复状态、保留复测依据', recs[0].status === 'reopened' && !!recs[0].retestReadingId);
check('第一轮固化的处置字段未被第二轮覆盖', JSON.stringify({
  id: recs[0].id, seq: recs[0].seq, cause: recs[0].cause, reason: recs[0].reason,
  closedAt: recs[0].closedAt, closedBy: recs[0].closedBy, options: recs[0].options,
  affected: recs[0].affected, refundTotal: recs[0].refundTotal, refundCount: recs[0].refundCount,
  voucherCount: recs[0].voucherCount, taskIds: recs[0].taskIds, announcementIds: recs[0].announcementIds,
  guardReliefCount: recs[0].guardReliefCount, incidentIds: recs[0].incidentIds,
}) === rec1Snapshot);
check('第一轮退费总额与笔数保留', recs[0].refundTotal === rec1After.refundTotal && recs[0].affected.length === rec1After.affected.length);
check('场次指向第二轮生效档案', st.sessions.find((s) => s.id === 's-mid').activeClosureId === rec2.id);

console.log('⑤ 第二轮复测恢复，两份档案并存可追溯');
r = await api('/water', mt, { sessionId: 's-mid', tempC: 27, freeChlorine: 0.7, turbidity: 0.5, ph: 7.2, note: '加氯后复测' });
check('第二轮复测达标', r.status === 201);
r = await api('/pool-status', ops, { sessionId: 's-mid', status: 'normal' });
check('第二轮恢复开放', r.status === 200);
st = await state(ops);
recs = st.closureRecords.filter((x) => x.sessionId === 's-mid').sort((a, b) => a.seq - b.seq);
check('两份档案均为已恢复且原因各自独立', recs.length === 2 && recs[0].reason.includes('雷电') && recs[1].reason.includes('余氯') && recs.every((x) => x.status === 'reopened'));
check('场次 closureIds 记录两轮', st.sessions.find((s) => s.id === 's-mid').closureIds.length === 2);

console.log('⑥ 居民视图：各自只看到自己的退费/补偿档案条目');
const stLi = await state(li);
check('居民可见两份档案（自己两轮均受影响）', stLi.closureRecords.length >= 2);
check('居民档案不含其他居民条目', stLi.closureRecords.every((c) => c.affected.every((a) => a.userId === 'u-li')));
check('居民钱包两笔闭池退费分别引用不同档案 id', (() => {
  const refunds = stLi.walletTxns.filter((t) => t.amount > 0 && t.closureId);
  const ids = new Set(refunds.map((t) => t.closureId));
  return refunds.length >= 2 && ids.size >= 2;
})());
check('居民收到两轮不同闭池通知', stLi.notifications.filter((n) => n.title.includes('闭池通知')).length >= 2);
const stClRaw = JSON.stringify(stLi);
check('居民视图无其他居民姓名/电话', !stClRaw.includes('张为民') && !stClRaw.includes('13800000001'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('失败项：', fails); process.exit(1); }
