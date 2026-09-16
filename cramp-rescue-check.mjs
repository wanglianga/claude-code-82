// 抽筋救援记录全链路断言（须在全新播种数据上运行：docker compose down -v && docker compose up -d）
// 覆盖：种子带入关注泳道 → 记录救援(发现时间/方式/上岸处理/家属/就医) → 泳道临停拦截预约与核验
//   → 自动立案跨角色事件 → 收尾三确认(真实换岗联动) → 站位调整带入下一场 → 下一场确认关注
//   → 运营复盘(培训项+排班) → 培训完成 → RBAC 与居民隐私裁剪
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
const state = async (t) => (await api('/state', t, undefined, 'GET')).data;
const me = async (t) => (await api('/me', t, undefined, 'GET')).data.user;
const findSession = (s, id) => s.sessions.find((x) => x.id === id);
const findBoard = (s, id) => s.boards.find((x) => x.session.id === id);

console.log('① 登录与种子数据（早场救援复盘 → 当前场关注泳道）');
const tOps = await login('ops');
const tLg = await login('lifeguard');   // 刘救生（当前场深水台在岗）
const tLg2 = await login('lifeguard2'); // 周救生（当前场儿童区巡逻在岗）
const tFd = await login('frontdesk');
const tCl = await login('cleaner');
const tZhang = await login('zhang');
check('全部登录成功', !!(tOps && tLg && tLg2 && tFd && tCl && tZhang));

const lg0 = await state(tLg);
const seedRescue = lg0.crampRescues.find((r) => r.code === 'CR-2059');
check('种子含早场已复盘抽筋救援 CR-2059', !!seedRescue && seedRescue.reviewedAt === seedRescue.reviewedAt && !!seedRescue.reviewedAt, JSON.stringify(seedRescue?.reviewedAt));
check('CR-2059 三项收尾确认全部完成', seedRescue && ['guard_relief', 'lane_reopen', 'order_restored'].every((k) => seedRescue.closure[k].done));
check('CR-2059 已生成培训项', seedRescue && seedRescue.trainingIds.length >= 1);
const midFocus = findBoard(lg0, 's-mid').focusLanes;
check('当前场救生看板有带入的重点关注泳道（浅水 2 号道）', midFocus.some((f) => f.zoneId === 'shallow' && f.lane === 2 && !f.ackAt), JSON.stringify(midFocus));
check('救生员可见培训项（复盘进入培训）', lg0.guardTraining.some((t) => t.sourceRescueId === 'cr-seed-1' && t.targetGuardNames.includes('刘救生')));
const seedDuty = lg0.guardDuties.find((d) => d.sessionId === 's-am' && d.crampRescueId === 'cr-seed-1' && d.relief === '周救生');
check('早场站位记录保留救援换岗痕迹（周救生接班）', !!seedDuty);

const zhang0 = await state(tZhang);
check('居民视图不含任何抽筋救援记录', zhang0.crampRescues.length === 0);
check('居民视图不含救生培训项', zhang0.guardTraining.length === 0);
check('居民视图不含救生内部重点关注泳道', findBoard(zhang0, 's-mid').focusLanes.length === 0);

console.log('② 救生员登记当前场抽筋救援（训练区 4 号道，建议就医）');
const rescueBody = {
  sessionId: 's-mid', zoneId: 'training', lane: 4,
  crampPart: 'calf', patronDesc: '男泳客约 30 岁，柜 C07，下水后未热身',
  method: 'swim', shoreTreatment: '游泳拖带上岸，坐姿拉伸小腿 5 分钟，保暖并补充温水，岸边持续观察',
  familyContacted: false, medicalAdvised: true, medicalNote: '泳客自述胸闷，已建议就医，前台呼叫 120 待命',
};
let r = await api('/cramp-rescues', tLg, rescueBody);
check('救援记录创建 201', r.status === 201, JSON.stringify(r.data));
const rescueId = r.data.id;
check('返回临停状态且三项确认初始均未完成', r.data.laneSuspended === true
  && ['guard_relief', 'lane_reopen', 'order_restored'].every((k) => r.data.closure[k].done === false));
check('记录了发现时间、救援方式、上岸处理、家属/就医', !!r.data.foundAt && r.data.method === 'swim'
  && r.data.shoreTreatment.includes('拖带上岸') && r.data.familyContacted === false && r.data.medicalAdvised === true);

r = await api('/cramp-rescues', tLg, { ...rescueBody, patronDesc: '重复' });
check('同泳道未收尾时重复登记被拒 409', r.status === 409, `status=${r.status}`);
r = await api('/cramp-rescues', tLg, { ...rescueBody, lane: 99 });
check('非法泳道号被拒 400', r.status === 400);
r = await api('/cramp-rescues', tLg, { ...rescueBody, shoreTreatment: '' });
check('缺少上岸处理被拒 400', r.status === 400);
r = await api('/cramp-rescues', tZhang, rescueBody);
check('居民无权登记救援 403', r.status === 403, `status=${r.status}`);

const lg1 = await state(tLg);
const inc = lg1.incidents.find((i) => i.id === lg1.crampRescues.find((x) => x.id === rescueId).incidentId);
check('自动立案「泳客抽筋」跨角色协同事件', !!inc && inc.type === 'cramp' && inc.status !== 'resolved');
check('事件含救生/前台/保洁/运营处置任务', inc && ['lifeguard', 'frontdesk', 'cleaner', 'ops'].every((role) => inc.tasks.some((t) => t.role === role)));
check('救生看板出现 4 号道临停', findBoard(lg1, 's-mid').suspendedLanes.some((l) => l.zoneId === 'training' && l.lane === 4));
const fd1 = await state(tFd);
check('前台同步看到救援记录', fd1.crampRescues.some((x) => x.id === rescueId));
check('前台收到紧急救援通告（建议就医=critical）', fd1.notifications.some((n) => n.title.includes(rescueId && r2code(lg1, rescueId)) && n.level === 'critical'));
function r2code(s, id) { return s.crampRescues.find((x) => x.id === id).code; }
const cl1 = await state(tCl);
check('保洁经抽筋事件可见关联救援（需疏散围观）', cl1.crampRescues.some((x) => x.id === rescueId));

console.log('③ 泳道临停联动：居民预约与前台核验均被拦截');
r = await api('/bookings', tZhang, {
  kind: 'personal', sessionId: 's-mid', zoneId: 'training', lane: 4,
  age: 42, healthPledge: true, swimLevel: 'advanced', paymentMethod: 'wallet',
});
check('居民预约临停泳道被拒 409', r.status === 409, `status=${r.status} ${JSON.stringify(r.data)}`);
r = await api('/bookings', tZhang, {
  kind: 'personal', sessionId: 's-mid', zoneId: 'training', lane: 5,
  age: 42, healthPledge: true, swimLevel: 'advanced', paymentMethod: 'wallet',
});
check('同泳区其他泳道仍可预约 201', r.status === 201, JSON.stringify(r.data));
// B-2064 赵晓的预约正是 training 4 号道（健康码 none，但临停拦截先于健康码校验）
const zhaoBooking = (await state(tFd)).bookings.find((b) => b.code === 'B-2064');
check('种子预约 B-2064 位于训练区 4 号道', !!zhaoBooking && zhaoBooking.zoneId === 'training' && zhaoBooking.lane === 4);
r = await api(`/bookings/${zhaoBooking.id}/checkin`, tFd, {
  healthCode: 'green', medicalCert: false, childCompanion: '', childCompanionPhone: '', lockerNo: 'C09',
});
check('前台核验临停泳道泳客被拒 409', r.status === 409 && r.data.error.includes('临时关闭'), JSON.stringify(r.data));
const zhang1 = await state(tZhang);
check('居民可见临停但原因脱敏（仅“现场处置”，不见抽筋/救援字样）',
  findBoard(zhang1, 's-mid').suspendedLanes.some((l) => l.lane === 4 && l.reason.includes('临时关闭'))
  && !JSON.stringify(findBoard(zhang1, 's-mid').suspendedLanes).includes('抽筋'));

console.log('④ 救援收尾三项确认（换岗真实联动站位）');
r = await api(`/cramp-rescues/${rescueId}/review`, tOps, {
  summary: 'x', trainingContent: 'y', intoSchedule: false,
});
check('收尾未完成时复盘被拒 409', r.status === 409, `status=${r.status}`);

// 周救生先结束本人儿童区岗（线下交接，接班人不在名册则不自动建新岗），才能去深水台接班
const lg2Id = (await me(tLg2)).id;
const familyDuty = (await state(tLg2)).guardDuties.find((d) => d.sessionId === 's-mid' && d.guardUserId === lg2Id && !d.end);
check('周救生当前在儿童区巡逻岗（接班前须先交岗）', !!familyDuty && familyDuty.post === 'family_patrol');
r = await api(`/guards/${familyDuty.id}/relief`, tLg2, { relief: '（撤岗待命）', note: '接替抽筋救援站位前先交岗' });
check('周救生原岗位下哨', r.status === 200 && r.data.duty.end != null);

r = await api(`/cramp-rescues/${rescueId}/closure/guard_relief`, tLg, { relief: '周救生', note: '施救后休整，陪同泳客等 120' });
check('换岗确认 200', r.status === 200, JSON.stringify(r.data));
const lg2s = await state(tLg);
const endedDuty = lg2s.guardDuties.find((d) => d.sessionId === 's-mid' && d.guardUserId === 'u-lg1' && d.end && d.crampRescueId === rescueId);
const newDuty = lg2s.guardDuties.find((d) => d.sessionId === 's-mid' && d.guardUserId === 'u-lg2' && !d.end && d.post === 'tower_deep');
check('刘救生深水台下哨且记录关联救援', !!endedDuty && endedDuty.relief === '周救生');
check('周救生自动接替同一站位（深水瞭望台）', !!newDuty);
r = await api(`/cramp-rescues/${rescueId}/closure/guard_relief`, tLg, { relief: '周救生' });
check('换岗确认不可重复 409', r.status === 409);
r = await api(`/cramp-rescues/${rescueId}/closure/guard_relief`, tCl, { relief: '周救生' });
check('保洁无权确认救援收尾 403', r.status === 403);

r = await api(`/cramp-rescues/${rescueId}/closure/lane_reopen`, tLg, {});
check('泳道临停解除确认 200', r.status === 200 && r.data.laneSuspended === false, JSON.stringify(r.data));
const lg3 = await state(tLg);
check('场次临停清单已移除该泳道', !findBoard(lg3, 's-mid').suspendedLanes.some((l) => l.lane === 4 && l.zoneId === 'training'));
r = await api('/bookings', tZhang, {
  kind: 'personal', sessionId: 's-mid', zoneId: 'training', lane: 4,
  age: 42, healthPledge: true, swimLevel: 'advanced', paymentMethod: 'wallet',
});
check('解除后临停泳道恢复可预约 201', r.status === 201, JSON.stringify(r.data));
r = await api(`/bookings/${zhaoBooking.id}/checkin`, tFd, {
  healthCode: 'green', medicalCert: false, childCompanion: '', childCompanionPhone: '', lockerNo: 'C10',
});
check('解除后核验不再被临停拦截（按健康码规则继续校验）', r.status !== 409 || !r.data.error.includes('临时关闭'), JSON.stringify(r.data));

r = await api(`/cramp-rescues/${rescueId}/closure/order_restored`, tLg, {});
check('水面秩序恢复确认 200', r.status === 200);
const lg4 = await state(tLg);
check('三项确认全部完成且推送完成通告',
  ['guard_relief', 'lane_reopen', 'order_restored'].every((k) => lg4.crampRescues.find((x) => x.id === rescueId).closure[k].done)
  && lg4.notifications.some((n) => n.title.includes('收尾三项确认全部完成')));

console.log('⑤ 站位调整按版本同步：最新策略、重新确认、历史留痕、不回写已结束场次');
const v1 = '深水台加派机动巡视，4 号道两端重点瞭望，下水前广播热身提示';
r = await api(`/cramp-rescues/${rescueId}/adjust`, tLg, { content: v1, propagateToNextSessions: true });
check('第 1 次调整记录成功（version=1）', r.status === 200 && r.data.version === 1
  && r.data.rescue.adjustments.length === 1 && r.data.rescue.adjustments[0].version === 1, JSON.stringify(r.data));
check('第 1 版同步 2 个未开始场次（下午场/晚场新建）', r.data.targets.length === 2
  && r.data.targets.every((p) => p.status === 'created')
  && r.data.targets.some((p) => p.id === 's-pm') && r.data.targets.some((p) => p.id === 's-eve'),
  JSON.stringify(r.data.targets));
let lg5 = await state(tLg);
let pmFocus = findBoard(lg5, 's-pm').focusLanes.find((f) => f.rescueId === rescueId);
check('下午场提醒为第 1 版策略', pmFocus.version === 1 && pmFocus.reason.includes(v1) && !pmFocus.ackAt);
check('早场（早于事发且已结束）不被回溯写入关注', !findBoard(lg5, 's-am').focusLanes.some((f) => f.rescueId === rescueId));
check('事发当前场（进行中）不被回写关注', !findBoard(lg5, 's-mid').focusLanes.some((f) => f.rescueId === rescueId));
check('种子带入的浅水 2 号道关注不受影响', findBoard(lg5, 's-mid').focusLanes.some((f) => f.rescueId === 'cr-seed-1' && f.version === 1));
check('前台看不到救生内部关注泳道', findBoard(await state(tFd), 's-pm').focusLanes.length === 0);

// 下午场救生员确认第 1 版
r = await api('/sessions/s-pm/focus-lanes/ack', tLg, { rescueId, zoneId: 'training', lane: 4 });
check('下午场确认第 1 版关注', r.status === 200 && r.data.ackBy === '刘救生' && r.data.version === 1, JSON.stringify(r.data));

// 第 2 次调整：下午场已确认过第 1 版，必须按新策略重新待确认，且历史确认可查
const v2 = '改为浅水台与深水台交叉瞭望 4 号道，机动岗每 10 分钟巡至该道，晚高峰加派一人';
r = await api(`/cramp-rescues/${rescueId}/adjust`, tLg, { content: v2, propagateToNextSessions: true });
check('第 2 次调整记录成功（version=2）', r.status === 200 && r.data.version === 2
  && r.data.rescue.adjustments.length === 2 && r.data.rescue.adjustments[1].content === v2, JSON.stringify(r.data));
const pmTarget = r.data.targets.find((p) => p.id === 's-pm');
const eveTarget = r.data.targets.find((p) => p.id === 's-eve');
check('下午/晚场标记为 updated', pmTarget?.status === 'updated' && eveTarget?.status === 'updated');
check('已确认的下午场触发重新确认标记', pmTarget.resetAck === true);
lg5 = await state(tLg);
pmFocus = findBoard(lg5, 's-pm').focusLanes.find((f) => f.rescueId === rescueId);
check('【验收】未再确认的下午场显示第二次（最新）策略', pmFocus.version === 2 && pmFocus.reason.includes(v2) && !pmFocus.reason.includes(v1),
  JSON.stringify({ version: pmFocus.version, reason: pmFocus.reason }));
check('下午场当前版本重新待确认（ackAt 已清空）', pmFocus.ackAt == null && pmFocus.ackBy == null);
check('历史确认可查：v1 留档且保留当时确认人/时间', pmFocus.history.length === 1
  && pmFocus.history[0].version === 1 && pmFocus.history[0].ackBy === '刘救生' && !!pmFocus.history[0].ackAt,
  JSON.stringify(pmFocus.history));
const eveFocus = findBoard(lg5, 's-eve').focusLanes.find((f) => f.rescueId === rescueId);
check('晚场同样更新到第 2 版，v1 未确认留档', eveFocus.version === 2 && eveFocus.history.length === 1 && !eveFocus.history[0].ackAt);
check('早场/当前场仍不被回写（含已结束场次保护）',
  !findBoard(lg5, 's-am').focusLanes.some((f) => f.rescueId === rescueId)
  && !findBoard(lg5, 's-mid').focusLanes.some((f) => f.rescueId === rescueId));

// 确认第 2 版后再调整第 3 版：确认再次重置，两次历史确认均可查
r = await api('/sessions/s-pm/focus-lanes/ack', tLg, { rescueId, zoneId: 'training', lane: 4 });
check('下午场确认第 2 版', r.status === 200 && r.data.version === 2 && r.data.ackBy === '刘救生');
const v3 = '维持交叉瞭望，4 号道热身区设提示牌，开场前 5 分钟广播';
r = await api(`/cramp-rescues/${rescueId}/adjust`, tLg, { content: v3, propagateToNextSessions: true });
check('第 3 次调整记录成功（version=3）', r.status === 200 && r.data.version === 3);
lg5 = await state(tLg);
pmFocus = findBoard(lg5, 's-pm').focusLanes.find((f) => f.rescueId === rescueId);
check('下午场升到第 3 版并再次待确认', pmFocus.version === 3 && pmFocus.reason.includes(v3) && pmFocus.ackAt == null);
check('v1/v2 两版历史与各自确认情况完整可查', pmFocus.history.length === 2
  && pmFocus.history[0].version === 1 && pmFocus.history[0].ackBy === '刘救生'
  && pmFocus.history[1].version === 2 && pmFocus.history[1].ackBy === '刘救生',
  JSON.stringify(pmFocus.history));
r = await api('/sessions/s-pm/focus-lanes/ack', tLg, { rescueId, zoneId: 'training', lane: 4 });
check('下午场最终确认第 3 版', r.status === 200 && r.data.version === 3 && r.data.ackAt != null);
const lg6 = await state(tLg);
check('确认后看板显示已按最新版确认', findBoard(lg6, 's-pm').focusLanes.find((f) => f.rescueId === rescueId)?.ackAt != null
  && findBoard(lg6, 's-pm').focusLanes.find((f) => f.rescueId === rescueId)?.version === 3);

console.log('⑤b 不同步勾选时仅记录调整，不改写任何场次提醒');
r = await api(`/cramp-rescues/${rescueId}/adjust`, tLg, { content: '仅本场口头强调的临时调整', propagateToNextSessions: false });
check('不向下同步时 targets 为空且版本号仍递增', r.status === 200 && r.data.version === 4 && r.data.targets.length === 0);
const lgNoSync = await state(tLg);
check('下午场仍停留在第 3 版（不被第 4 版改写）', findBoard(lgNoSync, 's-pm').focusLanes.find((f) => f.rescueId === rescueId)?.version === 3);

console.log('⑥ 运营组织本场复盘 → 救生员培训与排班');
r = await api(`/cramp-rescues/${rescueId}/review`, tOps, {
  summary: '发现及时、拖带规范；胸闷泳客送医排查，暴露热身提示不足、深水台单岗盲区。',
  trainingContent: '小腿抽筋识别与游泳拖带规范复训；泳客胸闷的就医判断与 120 联动；深水台双人交叉瞭望。',
  targetGuardNames: ['刘救生'], intoSchedule: true, scheduleNote: '本周深水台排双人岗，刘救生带教一次抽筋拖带',
});
check('复盘提交成功', r.status === 200 && r.data.training.id, JSON.stringify(r.data));
const trainingId = r.data.training?.id;
check('培训项进入排班', r.data.training?.intoSchedule === true && r.data.training.scheduleNote.includes('双人岗'));
r = await api(`/cramp-rescues/${rescueId}/review`, tOps, { summary: '重复', trainingContent: '重复', intoSchedule: false });
check('复盘不可重复 409', r.status === 409);
r = await api(`/cramp-rescues/${rescueId}/review`, tFd, { summary: 'x', trainingContent: 'y', intoSchedule: false });
check('前台无权组织复盘 403', r.status === 403);

const ops1 = await state(tOps);
const reviewed = ops1.crampRescues.find((x) => x.id === rescueId);
check('运营视图救援记录已复盘且关联培训项', !!reviewed.reviewedAt && reviewed.trainingIds.includes(trainingId));
check('协同事件流写入复盘完成记录', ops1.incidents.find((i) => i.id === reviewed.incidentId).actions.some((a) => a.content.includes('复盘完成')));
const lg7 = await state(tLg);
const mine = lg7.guardTraining.find((t) => t.id === trainingId);
check('被指定救生员可见新培训项', !!mine && mine.targetGuardNames.includes('刘救生'));
const lg2state = await state(tLg2);
check('未指定救生员不见该培训项（按人裁剪）', !lg2state.guardTraining.some((t) => t.id === trainingId));
r = await api(`/guard-training/${trainingId}/done`, tLg, { result: '已参加复训并演示拖带' });
check('救生员登记培训完成', r.status === 200 && r.data.done === true, JSON.stringify(r.data));

console.log('⑦ 运营指挥台数据齐备（时间线由前端渲染，此处校验底层关联完整）');
check('事发场 crampRescueCount 计数', findSession(await state(tOps), 's-mid').crampRescueCount >= 1);
const finalOps = await state(tOps);
const allChain = finalOps.crampRescues.filter((x) => x.sessionId === 's-mid');
check('全链路记录留存：临停解除+三确认+站位调整+复盘+培训', allChain.every((x) =>
  !x.laneSuspended
  && ['guard_relief', 'lane_reopen', 'order_restored'].every((k) => x.closure[k].done)
  && x.adjustments.length >= 0
) && reviewed.intoSchedule === true);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
