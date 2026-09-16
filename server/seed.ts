import type {
  DB, User, Zone, Session, Booking, WaterReading, Equipment, GuardDuty,
  PatrolIssue, WorkTask, Complaint, Notification, WalletTxn, CoachingLesson,
} from '../shared/types.js';

// 以“当前时刻”为锚生成演示数据：上午公众场正在进行、在池有人、水质读数与上哨时间都在过去，
// 保证任何时间启动容器，业务链路（含闭池后“复测必须晚于闭池时间”）都自洽。
const date = new Date().toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, '0');
function hhmm(offsetMin: number) {
  const d = new Date(Date.now() + offsetMin * 60000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const rel = (deltaMin: number) => new Date(Date.now() + deltaMin * 60000).toISOString();

let seq = 100;
const nid = (p: string) => `${p}-${++seq}`;

export function seed(): DB {
  seq = 100;

  const users: User[] = [
    // ---- 居民 ----
    { id: 'u-zhang', username: 'zhang', password: '123456', name: '张为民', role: 'resident', phone: '13800000001', memberTier: 'gold', deepCert: true, walletBalance: 320, compVouchers: 0, age: 42 },
    { id: 'u-li', username: 'li', password: '123456', name: '李娟', role: 'resident', phone: '13800000002', memberTier: 'silver', deepCert: false, walletBalance: 80, compVouchers: 0, age: 35 },
    { id: 'u-wang', username: 'wang', password: '123456', name: '王建国', role: 'resident', phone: '13800000003', memberTier: 'normal', deepCert: false, walletBalance: 0, compVouchers: 0, age: 68 },
    { id: 'u-zhao', username: 'zhao', password: '123456', name: '赵晓（访客）', role: 'resident', phone: '13800000004', memberTier: 'guest', deepCert: false, walletBalance: 0, compVouchers: 0, age: 29 },
    { id: 'u-lan', username: 'lan', password: '123456', name: '蓝鲸游泳培训', role: 'resident', phone: '13800000005', memberTier: 'institution', walletBalance: 2000, compVouchers: 0 },
    // ---- 工作人员 ----
    { id: 'u-fd', username: 'frontdesk', password: '123456', name: '陈前台', role: 'frontdesk' },
    { id: 'u-lg1', username: 'lifeguard', password: '123456', name: '刘救生', role: 'lifeguard' },
    { id: 'u-lg2', username: 'lifeguard2', password: '123456', name: '周救生', role: 'lifeguard' },
    { id: 'u-cl', username: 'cleaner', password: '123456', name: '吴保洁', role: 'cleaner' },
    { id: 'u-mt', username: 'maintenance', password: '123456', name: '郑维修', role: 'maintenance' },
    { id: 'u-ops', username: 'ops', password: '123456', name: '孙运营', role: 'ops' },
  ];

  const zones: Zone[] = [
    { id: 'training', name: '训练泳道区', capacity: 48, risk: 'medium', requireCert: false,
      rules: ['按泳道游进，慢速靠右', '禁止潜泳超过 15 米', '教练课走专用教学道'] },
    { id: 'family', name: '亲子儿童区', capacity: 40, risk: 'medium', requireCert: false, isChildArea: true,
      rules: ['14 岁以下儿童须成人一对一陪同', '禁止奔跑推搡', '浮力玩具仅限本区域'] },
    { id: 'deep', name: '深水区', capacity: 30, risk: 'high', requireCert: true,
      rules: ['凭深水合格证入场', '连续游 200 米测试通过', '严禁初学者进入'] },
    { id: 'shallow', name: '浅水休闲区', capacity: 36, risk: 'low', requireCert: false,
      rules: ['水深 1.2 米', '禁止跳水', '老人晨泳优先使用 1-2 号道'] },
  ];

  const sessions: Session[] = [
    {
      id: 's-am', label: '早场·老人晨泳（公益）', date, start: hhmm(-200), end: hhmm(-80),
      poolStatus: 'normal', maxCapacity: 110, publicWelfare: true, locks: [], closureIds: [], createdAt: rel(-230),
    },
    {
      id: 's-mid', label: '当前场次·上午公众场', date, start: hhmm(-55), end: hhmm(65),
      poolStatus: 'normal', maxCapacity: 154, locks: [
        { id: 'lock-1', zoneId: 'training', lane: 1, reason: 'coaching', title: '蓝鲸培训·自由泳提高班', contactName: '赵晓', contactPhone: '13800000005', capacity: 8, isCommercial: false },
      ], closureIds: [], createdAt: rel(-120),
    },
    {
      id: 's-pm', label: '下午公众场', date, start: hhmm(150), end: hhmm(270),
      poolStatus: 'normal', maxCapacity: 154, locks: [
        { id: 'lock-2', zoneId: 'family', reason: 'institution_rental', title: '蓝鲸游泳培训机构·少儿包场（洽谈中）', contactName: '赵晓', contactPhone: '13800000005', capacity: 30, isCommercial: true },
      ], closureIds: [], createdAt: rel(-60),
    },
    {
      id: 's-eve', label: '晚场·暑期儿童高峰', date, start: hhmm(360), end: hhmm(480),
      poolStatus: 'normal', maxCapacity: 154, locks: [], closureIds: [], createdAt: rel(-30),
    },
  ];

  const bookings: Booking[] = [
    {
      id: nid('bk'), code: 'B-2061', userId: 'u-zhang', kind: 'personal', sessionId: 's-mid', zoneId: 'training', lane: 3,
      periodLabel: `${sessions[1].start}-${sessions[1].end}`, age: 42, healthPledge: true, healthCode: 'green', medicalCert: true,
      withChildren: false, childCount: 0, swimLevel: 'advanced', partySize: 1, status: 'checked_in',
      paidAmount: 25, paymentMethod: 'wallet', lockerNo: 'A12', checkedInAt: rel(-18), checkedInBy: '陈前台', createdAt: rel(-95),
    },
    {
      id: nid('bk'), code: 'B-2062', userId: 'u-li', kind: 'parent_child', sessionId: 's-mid', zoneId: 'family',
      periodLabel: `${sessions[1].start}-${sessions[1].end}`, age: 35, healthPledge: true, healthCode: 'green', medicalCert: false,
      withChildren: true, childCount: 1, childCompanion: '李娟（母亲）', childCompanionPhone: '13800000002',
      swimLevel: 'beginner', partySize: 2, childrenInParty: 1, status: 'booked',
      paidAmount: 40, paymentMethod: 'wallet', createdAt: rel(-80),
    },
    {
      id: nid('bk'), code: 'B-2063', userId: 'u-wang', kind: 'elder_morning', sessionId: 's-am', zoneId: 'shallow', lane: 1,
      periodLabel: `${sessions[0].start}-${sessions[0].end}`, age: 68, healthPledge: true, healthCode: 'green', medicalCert: true,
      withChildren: false, childCount: 0, swimLevel: 'beginner', partySize: 1, status: 'checked_in',
      paidAmount: 0, paymentMethod: 'cash', lockerNo: 'B03', checkedInAt: rel(-190), checkedInBy: '陈前台', createdAt: rel(-210),
    },
    {
      id: nid('bk'), code: 'B-2064', userId: 'u-zhao', kind: 'guest', sessionId: 's-mid', zoneId: 'training', lane: 4,
      periodLabel: `${sessions[1].start}-${sessions[1].end}`, age: 29, healthPledge: true, healthCode: 'none', medicalCert: false,
      withChildren: false, childCount: 0, swimLevel: 'intermediate', partySize: 1, status: 'booked',
      paidAmount: 45, paymentMethod: 'cash', createdAt: rel(-55),
    },
    {
      id: nid('bk'), code: 'B-2065', userId: 'u-zhang', kind: 'personal', sessionId: 's-mid', zoneId: 'deep',
      periodLabel: `${sessions[1].start}-${sessions[1].end}`, age: 42, healthPledge: true, healthCode: 'green', medicalCert: true,
      withChildren: false, childCount: 0, swimLevel: 'advanced', partySize: 1, status: 'booked',
      paidAmount: 25, paymentMethod: 'voucher', createdAt: rel(-50),
    },
    {
      id: nid('bk'), code: 'B-2066', userId: 'u-li', kind: 'parent_child', sessionId: 's-pm', zoneId: 'family',
      periodLabel: `${sessions[2].start}-${sessions[2].end}`, age: 35, healthPledge: true, healthCode: 'green', medicalCert: false,
      withChildren: true, childCount: 1, childCompanion: '李娟（母亲）', childCompanionPhone: '13800000002',
      swimLevel: 'beginner', partySize: 2, childrenInParty: 1, status: 'booked',
      paidAmount: 40, paymentMethod: 'wallet', createdAt: rel(-35),
    },
  ];

  const waterReadings: WaterReading[] = [
    {
      id: nid('w'), sessionId: 's-mid', at: rel(-12), tempC: 27.2, freeChlorine: 0.8, turbidity: 0.6, ph: 7.3,
      recorder: '刘救生', abnormal: false, abnormalFields: [], note: '开场前检测，各项正常',
    },
  ];

  const equipment: Equipment[] = [
    { id: 'eq-pump', name: '循环水泵 1 号', zoneId: 'all', status: 'normal', lastCheck: rel(-40) },
    { id: 'eq-cl', name: '自动加氯机', zoneId: 'all', status: 'normal', lastCheck: rel(-40) },
    { id: 'eq-aed', name: 'AED 除颤仪', zoneId: 'all', status: 'normal', lastCheck: rel(-40), note: '电极片有效期至年底' },
    { id: 'eq-dehum', name: '除湿机（更衣室）', zoneId: 'all', status: 'warning', lastCheck: rel(-40), note: '排水略有堵塞，地面易湿滑' },
    { id: 'eq-cam', name: '水下监控', zoneId: 'deep', status: 'normal', lastCheck: rel(-40) },
  ];

  const guardDuties: GuardDuty[] = [
    { id: nid('gd'), sessionId: 's-mid', guardUserId: 'u-lg1', post: 'tower_deep', start: rel(-50) },
    { id: nid('gd'), sessionId: 's-mid', guardUserId: 'u-lg2', post: 'family_patrol', start: rel(-50) },
  ];

  const patrolIssues: PatrolIssue[] = [
    {
      id: nid('pi'), sessionId: 's-mid', at: rel(-25), type: 'wet_floor', severity: 'minor',
      description: '女更衣室出口地砖湿滑，已放置小心地滑提示牌', location: '更衣室出口',
      reporter: '吴保洁', assigneeRole: 'cleaner', assigneeName: '吴保洁', status: 'handling',
    },
  ];

  const workTasks: WorkTask[] = [
    { id: nid('wt'), sessionId: 's-mid', kind: 'cleaning', title: '淋浴区地漏清掏', detail: '高峰前清掏毛发、补充地垫', zoneId: 'all', assigneeRole: 'cleaner', assigneeName: '吴保洁', status: 'in_progress', createdAt: rel(-45), source: 'routine' },
    { id: nid('wt'), sessionId: 's-mid', kind: 'disinfection', title: '开场前氯消毒', detail: '按 0.8mg/L 余氯标准完成开场消毒', zoneId: 'all', assigneeRole: 'maintenance', assigneeName: '郑维修', status: 'done', createdAt: rel(-70), doneAt: rel(-55), result: '余氯 0.8，达标', source: 'routine' },
  ];

  const complaints: Complaint[] = [
    { id: nid('cp'), userId: 'u-li', at: rel(-300), category: '拥挤', content: '昨晚高峰场儿童区太挤，希望限流并加派救生员。', status: 'replied', reply: '已将晚场儿童区预约上限下调 15%，并增设机动巡视岗。', repliedAt: rel(-270) },
  ];

  const notifications: Notification[] = [
    { id: nid('nt'), at: rel(-50), title: '今日开场正常', body: '各泳区水质达标，当前场次准时开放。老人晨泳公益场免费。', level: 'info', roles: [], sessionId: 's-mid' },
    { id: nid('nt'), at: rel(-30), title: '商业包场冲突待协调', body: '蓝鲸培训申请在下午公众场整租亲子儿童区（30 人），与居民亲子公益预约（B-2066）存在冲突，请运营在同场次页面协调。', level: 'warning', roles: ['ops', 'frontdesk'], sessionId: 's-pm' },
  ];

  const walletTxns: WalletTxn[] = [
    { id: nid('tx'), at: rel(-95), userId: 'u-zhang', amount: -25, reason: '预约 B-2061 训练区入场', sessionId: 's-mid' },
    { id: nid('tx'), at: rel(-80), userId: 'u-li', amount: -40, reason: '预约 B-2062 亲子时段', sessionId: 's-mid' },
    { id: nid('tx'), at: rel(-35), userId: 'u-li', amount: -40, reason: '预约 B-2066 亲子时段', sessionId: 's-pm' },
  ];

  const lessons: CoachingLesson[] = [
    { id: 'ls-1', coachName: '马教练', title: '自由泳提高班', sessionId: 's-mid', zoneId: 'training', lane: 1, capacity: 8, enrolled: 5, price: 120, studentIds: ['u-zhang'] },
    { id: 'ls-2', coachName: '林教练', title: '少儿启蒙班', sessionId: 's-eve', zoneId: 'family', lane: 0, capacity: 6, enrolled: 6, price: 150, studentIds: ['u-li'] },
  ];

  return {
    users, zones, sessions, bookings, waterReadings, equipment, guardDuties,
    patrolIssues: [...patrolIssues], incidents: [], workTasks, complaints, notifications, walletTxns,
    lessons, closureRecords: [], counters: { seq }, seededAt: new Date().toISOString(),
  };
}
