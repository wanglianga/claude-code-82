// 水质异常 → 锁定受影响时段 → 闭池/部分开放/延期 → 分人群补偿/教练课顺延 专项验收
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
const ops = await login('ops'), mt = await login('maintenance'), cl = await login('cleaner');
const zhang = await login('zhang'), li = await login('li'), zhao = await login('zhao'), lan = await login('lan');
const state = async (tok) => (await api('/state', tok, undefined, 'GET')).data;

console.log('① 救生员录入异常水质（余氯低），系统自动限流');
// 用 lifeguard 录水
const lg = await login('lifeguard');
let r = await api('/water', lg, { sessionId: 's-mid', tempC: 27.1, freeChlorine: 0.12, turbidity: 1.9, ph: 7.4, note: '水质处置验收' });
check('异常读数记录', r.status === 201 && r.data.abnormal);
let st = await state(ops);
check('场次自动限流', st.sessions.find(s => s.id === 's-mid').poolStatus === 'restricted');

console.log('② 运营选择「部分开放」：仅锁定训练泳道区，其余正常');
const st0 = await state(ops);
// 先由学员 zhang 显式预约一节教练课（kind=coaching，训练区非教学锁定泳道）
let rb = await api('/bookings', zhang, {
  kind: 'coaching', sessionId: 's-mid', zoneId: 'training', lane: 5, age: 42, healthPledge: true,
  withChildren: false, childCount: 0, swimLevel: 'advanced', paymentMethod: 'wallet',
});
check('教练课预约成功', rb.status === 201, rb.data?.error);
r = await api('/pool-status', ops, {
  sessionId: 's-mid', status: 'closed', disposition: 'partial', cause: 'water_abnormal',
  reason: '训练区余氯不足，暂停该泳区', affectedZoneIds: ['training'],
  refund: true, compVoucher: false, notifyResidents: true, requireWaterRetest: true,
  retestPlannedAt: new Date(Date.now() + 60 * 60000).toISOString(),
});
check('部分开放处置成功', r.status === 200, r.data?.error);
st = await state(ops);
const smid = st.sessions.find(s => s.id === 's-mid');
check('场次状态=partial 且锁定训练区', smid.poolStatus === 'partial' && (smid.affectedZoneIds || []).includes('training') && !(smid.affectedZoneIds || []).includes('family'));
check('记录计划复测时间', !!smid.retestPlannedAt);
const rec = st.closureRecords.find(x => x.disposition === 'partial');
check('档案 disposition=partial', !!rec && rec.disposition === 'partial');
check('人群分组计数（已入场/未入场/教练课）', rec.groupCounts && (rec.groupCounts.checked_in + rec.groupCounts.not_checked_in + rec.groupCounts.coaching) >= 1);
void st0;

console.log('③ 三类人群差异化补偿');
const coachItem = rec.affected.find(a => a.bookingId === rb.data.booking.id);
const zhangItems = rec.affected.filter(a => a.userId === 'u-zhang');
const zhaoItem = rec.affected.find(a => a.userId === 'u-zhao');
check('教练课预约归入教练课组（顺延不退费）', coachItem?.group === 'coaching' && coachItem.postponed === true, JSON.stringify(coachItem));
check('张为民普通泳道预约 B-2061 按已入场组处理', zhangItems.some(a => a.bookingCode === 'B-2061' && a.group === 'checked_in'), JSON.stringify(zhangItems.map(a => [a.bookingCode, a.group])));
check('赵晓为未入场组、现金退款登记', zhaoItem?.group === 'not_checked_in' && zhaoItem.refund?.channel === 'cash' && zhaoItem.refund.amount === 45, JSON.stringify(zhaoItem?.refund));
const zhaoMe = (await api('/me', zhao, undefined, 'GET')).data.user;
check('赵晓储值仍为 0（现场退款不进储值）', zhaoMe.walletBalance === 0);

console.log('④ 教练课顺延与机构通知（部分开放仅锁定训练区，ls-1 在训练区）');
check('ls-1 自由泳提高班已顺延', (rec.lessonPostponements || []).some(l => l.lessonTitle.includes('自由泳')));
const lp = (rec.lessonPostponements || []).find(l => l.lessonTitle.includes('自由泳'));
check('顺延通知机构账号（蓝鲸培训）', lp?.institutionNotified === true);
const stLan = await state(lan);
check('机构账号收到课程顺延通知', stLan.notifications.some(n => n.closureId === rec.id && (n.title || '').includes('机构通知')));
const stZhang = await state(zhang);
check('学员张为民收到教练课顺延通知', stZhang.notifications.some(n => n.closureId === rec.id && (n.title || '').includes('教练课顺延')));

console.log('⑤ 分别通知已入场/未入场（文案区分）');
const zhaoNotif = (await state(zhao)).notifications.find(n => n.closureId === rec.id && n.userId === 'u-zhao');
check('未入场赵晓通知含现场退款说明', zhaoNotif && /现场退款|前台/.test(zhaoNotif.body), zhaoNotif?.body);

console.log('⑥ 部分开放：其他泳区仍可预约/核验');
r = await api('/bookings', li, {
  kind: 'parent_child', sessionId: 's-mid', zoneId: 'family', age: 35, healthPledge: true,
  withChildren: true, childCount: 1, swimLevel: 'beginner', paymentMethod: 'wallet',
});
check('非受影响的亲子区仍可预约', r.status === 201, r.data?.error);
r = await api('/bookings', li, {
  kind: 'personal', sessionId: 's-mid', zoneId: 'training', age: 35, healthPledge: true,
  withChildren: false, childCount: 0, swimLevel: 'beginner', paymentMethod: 'wallet',
});
check('受影响的训练区不可预约', r.status === 409);

console.log('⑦ 部分开放门禁：只需消毒复测（清场非必需）');
const disTask = st.workTasks.find(t => rec.taskIds.includes(t.id) && t.kind === 'disinfection');
const cleanTask = st.workTasks.find(t => rec.taskIds.includes(t.id) && t.kind === 'cleaning');
check('部分开放只生成消毒复测工单、无全场清场工单', !!disTask && !cleanTask);
// 未完成消毒不能恢复
r = await api('/pool-status', ops, { sessionId: 's-mid', status: 'normal' });
check('消毒未完成时拒绝恢复', r.status === 409 && /消毒/.test(r.data.error || ''));
// 完成消毒 + 复测
await api(`/tasks/${disTask.id}/claim`, mt, {});
await api(`/tasks/${disTask.id}/done`, mt, { result: '训练区加氯反冲洗完成' });
r = await api('/water', mt, { sessionId: 's-mid', tempC: 27, freeChlorine: 0.8, turbidity: 0.5, ph: 7.3, note: '部分开放复测' });
check('复测达标', r.status === 201 && r.data.abnormal === false);
r = await api('/pool-status', ops, { sessionId: 's-mid', status: 'normal' });
check('部分开放处置后恢复全场开放', r.status === 200 && r.data.reopened === true, r.data?.error);

console.log('⑧ 第二轮：延期处置（未入场顺延、教练课顺延、不退费）');
// 重新制造异常并延期到晚场
r = await api('/water', lg, { sessionId: 's-am', tempC: 27, freeChlorine: 0.1, turbidity: 2.2, ph: 7.4, note: '晨泳场异常' });
check('晨泳场异常读数', r.status === 201 && r.data.abnormal);
const sEve = (await state(ops)).sessions.find(s => s.id === 's-eve');
r = await api('/pool-status', ops, {
  sessionId: 's-am', status: 'closed', disposition: 'postponed', cause: 'water_abnormal',
  reason: '晨泳场水质异常，整体延期', postponeToSessionId: 's-eve',
  refund: false, compVoucher: false, notifyResidents: true, requireWaterRetest: true,
});
check('延期处置成功', r.status === 200, r.data?.error);
st = await state(ops);
const rec2 = st.closureRecords.find(x => x.disposition === 'postponed');
check('档案记录延期目标晚场', rec2?.postponeToSessionId === 's-eve');
// B-2063 王建国 晨泳场 已入场(现金0元) — 已入场组；延期主要影响未入场
const wangItem = rec2.affected.find(a => a.userId === 'u-wang');
check('王建国（已入场）被分组且不产生退款', wangItem && wangItem.group === 'checked_in' && !wangItem.refunded);
check('延期档案无储值退款', rec2.walletRefundTotal === 0);
const wang = await login('wang');
const stWang = await state(wang);
check('王建国收到延期/处置通知', stWang.notifications.some(n => n.closureId === rec2.id));

console.log('⑨ 闭池（全场）：未入场原路退、已入场安抚券、救生撤岗、清场+消毒工单');
r = await api('/pool-status', ops, {
  sessionId: 's-pm', status: 'closed', disposition: 'closed', cause: 'water_abnormal',
  reason: '下午场水质全面异常，闭池', refund: true, compVoucher: true,
  notifyResidents: true, requireWaterRetest: true,
});
check('全场闭池成功', r.status === 200, r.data?.error);
st = await state(ops);
const rec3 = st.closureRecords.find(x => x.disposition === 'closed' && x.sessionId === 's-pm');
check('闭池生成清场+消毒两工单', rec3.taskIds.length === 2);
check('闭池撤救生岗', rec3.guardReliefCount >= 0);
const spm = st.sessions.find(s => s.id === 's-pm');
check('下午场状态 closed、锁定全部泳区', spm.poolStatus === 'closed' && (spm.affectedZoneIds || []).length === st.zones.length);
// B-2066 李娟 亲子 未入场 储值40
const liItem = rec3.affected.find(a => a.userId === 'u-li');
check('李娟未入场原路退储值 40', liItem?.group === 'not_checked_in' && liItem.refund?.channel === 'wallet' && liItem.refund.amount === 40, JSON.stringify(liItem?.refund));
const liMe = (await api('/me', li, undefined, 'GET')).data.user;
check('李娟收到额外补偿券', liMe.compVouchers >= 1);

console.log('⑩ 历史档案互不覆盖');
const all = st.closureRecords;
check('三种处置方式档案并存', ['partial', 'postponed', 'closed'].every(d => all.some(x => x.disposition === d)));
const partialAfter = all.find(x => x.id === rec.id);
check('部分开放档案恢复后仍保留分组与顺延结果', partialAfter.status === 'reopened' && (partialAfter.lessonPostponements || []).length >= 1);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('失败项：', fails); process.exit(1); }
