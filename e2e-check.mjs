const BASE = process.env.TARGET || 'http://host.docker.internal:3082/api';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
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
  } catch (e) {
    return { status: 0, data: { error: e.cause?.code + ' ' + (e.cause?.message || '') + ' | ' + e.message } };
  }
}

const login = async (u) => (await api('/auth/login', null, { username: u, password: '123456' })).data.token;

// ---------- 1. 各角色登录 ----------
console.log('① 六角色登录');
const tOps = await login('ops');
const tFd = await login('frontdesk');
const tLg = await login('lifeguard');
const tCl = await login('cleaner');
const tMt = await login('maintenance');
const tLi = await login('li');
check('全部登录成功', !!(tOps && tFd && tLg && tCl && tMt && tLi));

const stateBefore = (await api('/state', tOps, undefined, 'GET')).data;

// ---------- 2. 居民预约亲子时段 ----------
console.log('② 居民（李娟）预约上午公众场亲子时段');
let r = await api('/bookings', tLi, {
  kind: 'parent_child', sessionId: 's-mid', zoneId: 'family',
  age: 35, healthPledge: true, healthCode: 'green',
  withChildren: true, childCount: 1, childCompanion: '李娟（母亲）', childCompanionPhone: '13800000002',
  swimLevel: 'beginner', paymentMethod: 'wallet',
});
check('亲子预约创建成功', r.status === 201, JSON.stringify(r.data));
const bookingId = r.data.booking?.id;
const bookingCode = r.data.booking?.code;
const liAfterBook = (await api('/me', tLi, undefined, 'GET')).data.user;
check('储值已扣款 40 元', liAfterBook.walletBalance === 40, `余额=${liAfterBook.walletBalance}`);

// 不签健康承诺应被拒
r = await api('/bookings', tLi, {
  kind: 'personal', sessionId: 's-mid', zoneId: 'training',
  age: 35, healthPledge: false, withChildren: false, childCount: 0, swimLevel: 'beginner',
});
check('未签健康承诺被拒（400）', r.status === 400);

// 无深水证预约深水区被拒
r = await api('/bookings', tLi, {
  kind: 'personal', sessionId: 's-mid', zoneId: 'deep',
  age: 35, healthPledge: true, withChildren: false, childCount: 0, swimLevel: 'beginner',
});
check('无深水证进深水区被拒（403）', r.status === 403);

// ---------- 3. 前台核验 ----------
console.log('③ 前台核验预约（健康码/陪同人/储物柜）');
r = await api(`/bookings/${bookingId}/checkin`, tFd, {
  healthCode: 'green', medicalCert: false,
  childCompanion: '李娟（母亲）', childCompanionPhone: '13800000002', lockerNo: 'C07',
});
check('核验入场成功', r.status === 200 && r.data.status === 'checked_in', JSON.stringify(r.data));

// 重复柜号应冲突
r = await api('/bookings/B-2064'.replace('B-2064', stateBefore.bookings.find(b => b.code === 'B-2064').id) + '/checkin', tFd, {
  healthCode: 'green', medicalCert: false, childCompanion: '', childCompanionPhone: '', lockerNo: 'C07',
});
check('储物柜重复分配被拒', r.status === 409, `status=${r.status} ${r.data.error ?? ''}`);

// 健康码非绿拒绝
const zhaoB = stateBefore.bookings.find(b => b.code === 'B-2064');
r = await api(`/bookings/${zhaoB.id}/checkin`, tFd, {
  healthCode: 'expired', medicalCert: false, childCompanion: '', childCompanionPhone: '', lockerNo: 'C08',
});
check('非绿码拒绝放行', r.status === 400);

// ---------- 4. 救生员录入异常水质 → 自动限流+立案 ----------
console.log('④ 救生员录入异常水质（余氯低/浊度高）');
r = await api('/water', tLg, { sessionId: 's-mid', tempC: 27.1, freeChlorine: 0.15, turbidity: 1.8, ph: 7.4, note: 'E2E 异常注入' });
check('异常读数被记录', r.status === 201 && r.data.abnormal === true);
let st = (await api('/state', tOps, undefined, 'GET')).data;
const sess = st.sessions.find(s => s.id === 's-mid');
check('场次自动转为限流', sess.poolStatus === 'restricted', `status=${sess.poolStatus}`);
const waterInc = st.incidents.find(i => i.type === 'water_abnormal' && i.status !== 'resolved');
check('水质异常事件自动立案', !!waterInc);
check('事件包含五角色任务', ['lifeguard','frontdesk','maintenance','cleaner','ops'].every(role => waterInc.tasks.some(t => t.role === role)));
const maintTask = st.workTasks.find(t => t.incidentId === waterInc.id && t.assigneeRole === 'maintenance');
check('维修端自动收到消毒/复测工单', !!maintTask);
const cleanTask = st.workTasks.find(t => t.incidentId === waterInc.id && t.assigneeRole === 'cleaner');
check('保洁端自动收到清场工单', !!cleanTask);

// 限流期间前台放行应被拒
r = await api(`/bookings/${zhaoB.id}/checkin`, tFd, {
  healthCode: 'green', medicalCert: false, childCompanion: '', childCompanionPhone: '', lockerNo: 'C09',
});
check('限流期间停止入场', r.status === 409);

// ---------- 5. 巡查上报 ----------
console.log('⑤ 救生员巡查：违规跳水 / 儿童离开陪同人');
r = await api('/issues', tLg, { sessionId: 's-mid', type: 'diving', severity: 'major', location: '深水区出发台', description: '一名青年男子屡次在深水区出发台跳水' });
check('违规跳水已记录并派救生岗', r.status === 201 && r.data.assigneeRole === 'lifeguard');
r = await api('/issues', tCl, { sessionId: 's-mid', type: 'wet_floor', severity: 'minor', location: '女更衣室出口', description: '地面积水' });
check('地面湿滑自动派保洁并生成工单', r.status === 201 && r.data.assigneeRole === 'cleaner');
st = (await api('/state', tCl, undefined, 'GET')).data;
check('保洁能在自己工单中看到', st.workTasks.some(t => t.assigneeRole === 'cleaner' && t.status === 'pending'));

// ---------- 6. 前台发起抽筋事件，救生员完成处置，运营关闭 ----------
console.log('⑥ 抽筋事件跨角色协同');
r = await api('/incidents', tFd, { sessionId: 's-mid', type: 'cramp', description: '训练区 3 道泳客右小腿抽筋' });
check('抽筋事件立案', r.status === 201);
const cramp = r.data;
const lgTask = cramp.tasks.find(t => t.role === 'lifeguard');
r = await api(`/incidents/${cramp.id}/tasks/${lgTask.id}/done`, tLg, {});
check('救生员完成自己的处置项', r.status === 200 && r.data.tasks.find(t => t.id === lgTask.id).done);
r = await api(`/incidents/${cramp.id}/tasks/${lgTask.id}/done`, tCl, {});
check('保洁不能勾选救生员任务（403）', r.status === 403);
r = await api(`/incidents/${cramp.id}/resolve`, tOps, {});
check('仍有未完成任务时运营不能直接关闭', r.status === 409);
for (const t of cramp.tasks.filter(x => !x.done && x.role !== 'lifeguard')) {
  const tok = { frontdesk: tFd, cleaner: tCl, maintenance: tMt, ops: tOps }[t.role];
  await api(`/incidents/${cramp.id}/tasks/${t.id}/done`, tok, {});
}
r = await api(`/incidents/${cramp.id}/resolve`, tOps, { summary: '泳客恢复，无需送医' });
check('全部处置完成后事件关闭', r.status === 200 && r.data.status === 'resolved');

// ---------- 7. 运营闭池：退费+补偿券+通知联动 ----------
console.log('⑦ 运营闭池（雷雨），联动退费/补偿券/复测/清场/通知');
const liBeforeClose = (await api('/me', tLi, undefined, 'GET')).data.user;
r = await api('/pool-status', tOps, {
  sessionId: 's-mid', status: 'closed', cause: 'thunderstorm',
  reason: '雷电黄色预警，雷雨临近临时闭池',
  refund: true, compVoucher: true, notifyResidents: true, requireWaterRetest: true,
});
check('闭池联动执行成功', r.status === 200, JSON.stringify(r.data));
check('受影响预约 > 0', r.data.affected > 0, `affected=${r.data.affected}`);
const liAfterClose = (await api('/me', tLi, undefined, 'GET')).data.user;
check('居民原路退费到账（余额回升）', liAfterClose.walletBalance > liBeforeClose.walletBalance, `${liBeforeClose.walletBalance} -> ${liAfterClose.walletBalance}`);
check('补偿券已发放（按受影响预约逐笔）', liAfterClose.compVouchers >= liBeforeClose.compVouchers + 1, `before=${liBeforeClose.compVouchers} after=${liAfterClose.compVouchers}`);
st = (await api('/state', tOps, undefined, 'GET')).data;
const bClosed = st.bookings.find(b => b.id === bookingId);
check('预约状态变为退费+补偿', bClosed.status === 'compensated', bClosed.status);
check('居民收到个人闭池通知', st.notifications.some(n => n.userId === liAfterClose.id && n.title.includes('闭池通知')));
check('救生岗闭池撤哨', st.guardDuties.filter(d => d.sessionId === 's-mid' && !d.end).length === 0);
check('生成闭池复测+清场工单', st.workTasks.some(t => t.sessionId === 's-mid' && t.title.includes('闭池后全面消毒')) && st.workTasks.some(t => t.sessionId === 's-mid' && t.title.includes('闭池清场')));

// ---------- 8. 恢复门禁：清场清洁 + 消毒复测工单 + 必要达标水质，三者齐备方可恢复 ----------
console.log('⑧ 恢复开放门禁：处置未完成一律拒绝 → 三项齐备后恢复');
let opsSt = (await api('/state', tOps, undefined, 'GET')).data;
let activeClosure = opsSt.closureRecords.find(c => c.sessionId === 's-mid' && c.status === 'closed');
check('存在本轮闭池档案', !!activeClosure);
const closureCleaning = opsSt.workTasks.find(t => activeClosure.taskIds.includes(t.id) && t.kind === 'cleaning');
const closureDisinfection = opsSt.workTasks.find(t => activeClosure.taskIds.includes(t.id) && t.kind === 'disinfection');
check('本轮联动生成清场+消毒工单', !!closureCleaning && !!closureDisinfection);

// 8.1 什么都没做：恢复被拒（错误消息点明缺项）
r = await api('/pool-status', tOps, { sessionId: 's-mid', status: 'normal' });
check('无任何处置时拒绝恢复', r.status === 409 && /清场清洁/.test(r.data.error || ''), r.data.error);

// 8.2 仅录入达标水质，工单未完成：仍拒绝；场次状态/通知/档案不变
r = await api('/water', tMt, { sessionId: 's-mid', tempC: 27.0, freeChlorine: 0.8, turbidity: 0.5, ph: 7.3, note: 'E2E 复测达标' });
check('维修提交复测达标读数', r.status === 201 && r.data.abnormal === false);
r = await api('/pool-status', tOps, { sessionId: 's-mid', status: 'normal' });
check('仅水质达标但清场/消毒待办未完成，仍拒绝恢复', r.status === 409 && (/清场清洁/.test(r.data.error) || /消毒复测/.test(r.data.error)), r.data.error);
opsSt = (await api('/state', tOps, undefined, 'GET')).data;
check('拒绝恢复后场次仍为闭池', opsSt.sessions.find(s => s.id === 's-mid').poolStatus === 'closed');
check('拒绝恢复未产生恢复通知', !opsSt.notifications.some(n => n.title.includes('恢复开放：')));
check('本轮档案仍为闭池状态（未被污染）', opsSt.closureRecords.find(c => c.id === activeClosure.id)?.status === 'closed');

// 8.3 完成清场清洁（保洁）与消毒复测（维修）工单
for (const [tok, task] of [[tCl, closureCleaning], [tMt, closureDisinfection]]) {
  const claim = await api(`/tasks/${task.id}/claim`, tok, {});
  check(`工单 ${task.kind} 可接单`, claim.status === 200, claim.data.error);
  const done = await api(`/tasks/${task.id}/done`, tok, { result: task.kind === 'cleaning' ? '池岸/淋浴/更衣室清场清洁完成' : '加氯反冲洗完成，复测达标' });
  check(`工单 ${task.kind} 可完成`, done.status === 200, done.data.error);
}
r = await api('/pool-status', tOps, { sessionId: 's-mid', status: 'normal' });
check('三项处置齐备后恢复开放成功', r.status === 200 && r.data.reopened === true, JSON.stringify(r.data));
opsSt = (await api('/state', tOps, undefined, 'GET')).data;
const finalClosure = opsSt.closureRecords.find(c => c.id === activeClosure.id);
check('档案回写恢复核验快照（清场/消毒/水质结果齐全）',
  !!finalClosure.reopenChecklist?.cleaning?.doneAt && !!finalClosure.reopenChecklist?.disinfection?.doneAt && !!finalClosure.reopenChecklist?.water?.readingId,
  JSON.stringify(finalClosure.reopenChecklist));
check('档案回写恢复时间与恢复通知', !!finalClosure.reopenedAt && (finalClosure.reopenNotificationIds || []).length === 2);

st = (await api('/state', tLi, undefined, 'GET')).data;
check('居民端看到恢复开放通告', st.notifications.some(n => n.title.includes('恢复开放')));

// ---------- 9. 商业包场 vs 公益冲突 ----------
console.log('⑨ 机构在老人晨泳公益场登记商业包场 → 冲突');
r = await api('/bookings', await login('lan'), {
  kind: 'institution_rental', sessionId: 's-am', zoneId: 'shallow',
  age: 30, healthPledge: true, withChildren: false, childCount: 0, swimLevel: 'intermediate',
  partySize: 20, orgName: '蓝鲸游泳培训', contactName: '赵晓', contactPhone: '13800000005', paymentMethod: 'cash',
});
check('公益时段商业包场返回冲突预警', r.status === 201 && (r.data.conflictWarnings || []).some(m => m.includes('公益')));
st = (await api('/state', tOps, undefined, 'GET')).data;
check('全局冲突列表出现该场次', st.conflicts.some(c => c.sessionId === 's-am'));

// 机构包场超额：训练区容量 48，申请 55 人包场
r = await api('/bookings', await login('lan'), {
  kind: 'institution_rental', sessionId: 's-pm', zoneId: 'training',
  age: 30, healthPledge: true, withChildren: false, childCount: 0, swimLevel: 'beginner',
  partySize: 55, orgName: '蓝鲸游泳培训', contactName: '赵晓', contactPhone: '13800000005', paymentMethod: 'cash',
});
check('超容量包场产生容量冲突提示', r.status === 201 && (r.data.conflictWarnings || []).some(m => m.includes('容量')));

// ---------- 10. 超额事件：制造容量超额预约 ----------
console.log('⑩ 预约超额自动立案');
const tZhang = await login('zhang');
// 深水区容量30，用机构账号连续包场触发超额不易；直接用 ops 视角确认 overbooking 机制：
// 用访客账号在 family 区反复团体预约直到超额
let gotOver = false;
for (let i = 0; i < 6; i++) {
  const rr = await api('/bookings', await login('lan'), {
    kind: 'group', sessionId: 's-eve', zoneId: 'family',
    age: 30, healthPledge: true, withChildren: false, childCount: 0, swimLevel: 'beginner',
    partySize: 8, contactName: '赵晓', contactPhone: '13800000005', paymentMethod: 'cash',
  });
  if (rr.data?.overCapacity) { gotOver = true; break; }
  if (rr.status !== 201) { check('团体预约循环中意外失败: ' + rr.data.error, false); break; }
}
check('容量超额时自动立案 overbooking', gotOver);

// ---------- 汇总 ----------
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
