// 跨角色数据泄露专项验收（服务端裁剪 /api/state，不依赖前端筛选）
// 前置：全新播种数据（docker compose down -v 后首次启动）
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

const t = {
  li: await login('li'), zhang: await login('zhang'), wang: await login('wang'),
  fd: await login('frontdesk'), lg: await login('lifeguard'),
  cl: await login('cleaner'), mt: await login('maintenance'), ops: await login('ops'),
};

console.log('① 居民 li：快照中不得包含任何其他居民的 PII');
const li = (await api('/state', t.li, undefined, 'GET')).data;
const liRaw = JSON.stringify(li);
check('li 只看到自己的预约', li.bookings.length > 0 && li.bookings.every((b) => b.userId === 'u-li'), `ids=${li.bookings.map(b => b.userId)}`);
check('li 看不到他人预约（不含 B-2061/B-2063/B-2064/B-2065）', !liRaw.includes('B-2061') && !liRaw.includes('B-2063') && !liRaw.includes('B-2065'));
check('li 钱包流水只含本人', li.walletTxns.length > 0 && li.walletTxns.every((x) => x.userId === 'u-li'));
check('快照中无其他居民手机号', !liRaw.includes('13800000001') && !liRaw.includes('13800000003') && !liRaw.includes('13800000004') && !liRaw.includes('13800000005'));
check('快照中无其他居民姓名', !liRaw.includes('张为民') && !liRaw.includes('王建国') && !liRaw.includes('蓝鲸游泳培训'));
check('快照中无其他居民的儿童陪同人信息', !liRaw.includes('陈前台') && !(li.bookings.some((b) => b.childCompanion && b.userId !== 'u-li')));
check('人员目录对居民为空', Array.isArray(li.users) && li.users.length === 0, `len=${li.users?.length}`);
check('居民看不到水质明细', li.waterReadings.length === 0 && li.boards.every((b) => b.water === null));
check('居民看不到设备清单/救生排班/事件流', li.boards.every((b) => b.equipment.length === 0 && b.guardOnDuty.length === 0 && b.openIncidents.length === 0) && li.incidents.length === 0);
check('居民看不到工单/巡查/投诉他人数据/冲突明细', li.workTasks.length === 0 && li.patrolIssues.length === 0 && li.complaints.every((c) => c.userId === 'u-li') && li.conflicts.length === 0);
check('居民仍可看到泳区聚合容量（必要聚合）', li.boards[0].zones.every((z) => typeof z.inPool === 'number' && typeof z.capacity === 'number'));
check('课程学员名单只含本人（已报名判断保留，他人 id 不泄露）', li.lessons.every((l) => l.studentIds.every((id) => id === 'u-li')));
check('通知仅广播/个人/角色相关', li.notifications.every((n) => n.roles.length === 0 || n.roles.includes('resident') || n.userId === 'u-li'));

console.log('② 居民 zhang/wang 之间互不可见');
const zhang = (await api('/state', t.zhang, undefined, 'GET')).data;
const wang = (await api('/state', t.wang, undefined, 'GET')).data;
check('zhang 快照无李娟信息', !JSON.stringify(zhang).includes('李娟') && !JSON.stringify(zhang).includes('13800000002'));
check('wang（老人）只看到自己的晨泳预约', wang.bookings.every((b) => b.userId === 'u-wang') && wang.bookings.some((b) => b.kind === 'elder_morning'));

console.log('③ 前台：可核验本场预约，但不见钱包余额/流水');
const fd = (await api('/state', t.fd, undefined, 'GET')).data;
check('前台可见全部预约（含待核验 B-2062/B-2064）', fd.bookings.some((b) => b.code === 'B-2062') && fd.bookings.some((b) => b.code === 'B-2064'));
check('前台可见核验所需泳客联系电话', (fd.users.find((u) => u.id === 'u-li') || {}).phone === '13800000002');
check('前台可见会员等级/深水证（核验需要）', fd.users.find((u) => u.id === 'u-zhang')?.deepCert === true);
check('前台人员卡片不含余额/补偿券字段', fd.users.every((u) => u.walletBalance === undefined && u.compVouchers === undefined && u.password === undefined));
check('前台看不到任何钱包流水', fd.walletTxns.length === 0);
check('前台看不到设备清单', fd.boards.every((b) => b.equipment.length === 0));

console.log('④ 救生员：人数/儿童/深水权限可见，无钱包与联系方式');
const lg = (await api('/state', t.lg, undefined, 'GET')).data;
check('救生员无逐笔预约', lg.bookings.length === 0);
check('救生员无钱包流水', lg.walletTxns.length === 0);
check('救生员人员目录仅救生员且无电话', lg.users.length >= 2 && lg.users.every((u) => u.role === 'lifeguard' && !u.phone && u.walletBalance === undefined));
check('看板提供各泳区在池人数/儿童数/深水证持有数', lg.boards[1].zones.every((z) => ['inPool', 'children', 'deepCertHoldersInPool', 'capacity'].every((k) => typeof z[k] === 'number')));
check('救生员可见水质与设备', lg.waterReadings.length >= 1 && lg.equipment.length >= 1);
check('救生员可见排班', lg.guardDuties.length >= 1);
const rawLg = JSON.stringify(lg);
check('救生员快照无泳客手机号', !rawLg.includes('13800000002') && !rawLg.includes('13800000001'));

console.log('⑤ 保洁/维修：仅本岗工单与本岗相关事件');
const cl = (await api('/state', t.cl, undefined, 'GET')).data;
const mt = (await api('/state', t.mt, undefined, 'GET')).data;
check('保洁工单全部是保洁岗', cl.workTasks.every((x) => x.assigneeRole === 'cleaner'));
check('维修工单全部是维修岗', mt.workTasks.every((x) => x.assigneeRole === 'maintenance'));
check('保洁看不到维修工单', !cl.workTasks.some((x) => x.assigneeRole === 'maintenance'));
check('两岗均无钱包/逐笔预约/投诉', cl.walletTxns.length === 0 && mt.walletTxns.length === 0 && cl.bookings.length === 0 && mt.complaints.length === 0);
check('保洁无设备清单，维修有设备清单', cl.boards.every((b) => b.equipment.length === 0) && mt.equipment.length >= 1);

console.log('⑥ 前台仍可核验本场预约（脱敏未破坏业务）');
const midBookings = fd.bookings.filter((b) => b.sessionId === 's-mid' && b.status === 'booked');
const b2062 = fd.bookings.find((b) => b.code === 'B-2062');
const ck = await api(`/bookings/${b2062.id}/checkin`, t.fd, {
  healthCode: 'green', medicalCert: false, childCompanion: '李娟（母亲）', childCompanionPhone: '13800000002', lockerNo: 'C21',
});
check('前台核验 B-2062 放行成功', ck.status === 200 && ck.data.status === 'checked_in', JSON.stringify(ck.data));
void midBookings;

console.log('⑦ 运营闭池联动：受影响居民各自只看到自己的退费与补偿');
const close = await api('/pool-status', t.ops, {
  sessionId: 's-mid', status: 'closed', cause: 'thunderstorm', reason: '隐私验收-雷雨闭池',
  refund: true, compVoucher: true, notifyResidents: true, requireWaterRetest: true,
});
check('闭池联动成功', close.status === 200, JSON.stringify(close.data));

const li2 = (await api('/state', t.li, undefined, 'GET')).data;
const zhang2 = (await api('/state', t.zhang, undefined, 'GET')).data;
check('li 只看到本人的闭池退费流水', li2.walletTxns.some((x) => x.amount > 0 && /闭池.*退储值|退储值/.test(x.reason) && x.userId === 'u-li'));
check('li 看不到 zhang 的退费', !JSON.stringify(li2).includes('B-2061'));
check('li 收到本人闭池通知（含其金额）', li2.notifications.some((n) => n.userId === 'u-li' && n.title.includes('闭池通知')));
check('li 本人预约为退费+补偿状态', li2.bookings.some((b) => b.code === 'B-2062' && b.status === 'compensated'));
check('zhang 看到自己的退费（B-2061 储值 +25）', zhang2.walletTxns.some((x) => x.amount === 25 && x.reason.includes('B-2061')));
check('zhang 看不到 li 的退费/陪同人', !JSON.stringify(zhang2).includes('李娟') && !JSON.stringify(zhang2).includes('B-2062'));

console.log('⑧ 运营视图完整（可指挥闭池全链路）');
const ops = (await api('/state', t.ops, undefined, 'GET')).data;
check('运营可见全部预约/工单/投诉/冲突/流水', ops.bookings.length >= 6 && ops.workTasks.length >= 4 && ops.conflicts.length >= 1 && ops.walletTxns.length >= 3);
check('运营人员卡片仍无密码字段', ops.users.every((u) => u.password === undefined));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('失败项：', fails); process.exit(1); }
