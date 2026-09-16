// 水质异常延期：教练课/未入场预约真实迁移到目标场次 专项验收
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
const ops = await login('ops'), fd = await login('frontdesk'), mt = await login('maintenance');
const zhang = await login('zhang'), li = await login('li');
const state = async (tok) => (await api('/state', tok, undefined, 'GET')).data;

// 播种：s-mid 训练区有 ls-1（学员 zhang）；新增一笔教练课预约（未入场）
let st = await state(ops);
let r = await api('/bookings', zhang, {
  kind: 'coaching', sessionId: 's-mid', zoneId: 'training', lane: 5, age: 42, healthPledge: true,
  withChildren: false, childCount: 0, swimLevel: 'advanced', paymentMethod: 'wallet',
});
check('教练课预约成功（未入场）', r.status === 201, r.data?.error);
const origId = r.data.booking.id;
const origCode = r.data.booking.code;

// 迁移前下午场训练区人数基线
st = await state(ops);
const beforeZone = st.boards.find(b => b.session.id === 's-pm').zones.find(z => z.zoneId === 'training');
const beforeBooked = beforeZone.booked;
const beforeInPool = beforeZone.inPool;
console.log(`迁移前下午场训练区 在池=${beforeInPool} 待入=${beforeBooked}`);

console.log('① 上午场水质异常，延期至下午场');
r = await api('/pool-status', ops, {
  sessionId: 's-mid', status: 'closed', disposition: 'postponed', cause: 'water_abnormal',
  reason: '上午场水质异常，延期至下午场', postponeToSessionId: 's-pm',
  refund: false, compVoucher: false, notifyResidents: true, requireWaterRetest: true,
});
check('延期处置成功', r.status === 200, JSON.stringify(r.data));

st = await state(ops);
const rec = st.closureRecords.find(x => x.disposition === 'postponed' && x.sessionId === 's-mid');
check('档案记录迁移笔数 ≥1', (rec.migratedBookingCount ?? 0) >= 1, `=${rec.migratedBookingCount}`);
check('档案 migrationSummary 含下午场', (rec.migrationSummary || []).some(m => m.sessionId === 's-pm' && m.count >= 1), JSON.stringify(rec.migrationSummary));

console.log('② 原预约保持 postponed 且双向关联');
const orig = st.bookings.find(b => b.id === origId);
check('原预约状态 postponed', orig.status === 'postponed', orig.status);
check('原预约指向下午场', orig.postponeToSessionId === 's-pm');
check('原预约记录新预约 id', !!orig.postponedBookingId);
const origItem = rec.affected.find(a => a.bookingId === origId);
check('档案条目记录 migratedBookingId', !!origItem?.migratedBookingId && origItem.postponeToSessionId === 's-pm');

console.log('③ 目标场次生成可核验 booked 新预约，容量+1');
const migrated = st.bookings.find(b => b.id === orig.postponedBookingId);
check('新预约存在且在下午场、状态 booked', migrated && migrated.sessionId === 's-pm' && migrated.status === 'booked', JSON.stringify(migrated && { s: migrated.sessionId, st: migrated.status }));
check('新预约反向关联原预约', migrated?.migratedFromBookingId === origId);
check('新预约关联闭池档案', migrated?.migratedClosureId === rec.id);
check('新预约费用保留、未二次扣款（金额与原单一致）', migrated.paidAmount === orig.paidAmount);
const afterZone = st.boards.find(b => b.session.id === 's-pm').zones.find(z => z.zoneId === 'training');
// 仅统计迁入「下午场训练区」的笔数（其他泳区迁入不计入训练区增量）
const migratedToPmTraining = st.bookings.filter(b => b.sessionId === 's-pm' && b.zoneId === 'training' && b.migratedClosureId === rec.id).length;
check('下午场训练区待入容量按迁入笔数增加', afterZone.booked === beforeBooked + migratedToPmTraining, `${beforeBooked}+${migratedToPmTraining} -> ${afterZone.booked}`);

console.log('④ 学员端看到目标场次有效预约');
const stZhang = await state(zhang);
const newInZhang = stZhang.bookings.find(b => b.id === migrated.id);
check('学员能看到下午场新预约（booked）', !!newInZhang && newInZhang.status === 'booked' && newInZhang.sessionId === 's-pm');
const origInZhang = stZhang.bookings.find(b => b.id === origId);
check('学员能看到原预约已顺延标注', origInZhang?.status === 'postponed' && origInZhang.postponedBookingId === migrated.id);
check('学员收到顺延通知', stZhang.notifications.some(n => n.closureId === rec.id && (n.title || '').includes('顺延')));

console.log('⑤ 前台可在下午场核验新预约入场');
const ck = await api(`/bookings/${migrated.id}/checkin`, fd, {
  healthCode: 'green', medicalCert: false, childCompanion: '', childCompanionPhone: '', lockerNo: 'P99',
});
check('前台核验迁移后的新预约放行成功', ck.status === 200 && ck.data.status === 'checked_in', JSON.stringify(ck.data));
st = await state(ops);
const afterCheckinZone = st.boards.find(b => b.session.id === 's-pm').zones.find(z => z.zoneId === 'training');
check('核验后下午场在池人数增加', afterCheckinZone.inPool === beforeInPool + 1, `${beforeInPool} -> ${afterCheckinZone.inPool}`);
// 已入场的新预约核验后，救生在场统计随之更新
check('救生看板下午场在池统计包含迁移学员', afterCheckinZone.inPool >= 1);

console.log('⑥ 目标场次满员或已闭池时，延期被拒绝且原预约不变（无死单）');

// 6.1 目标满员：用商业锁区把晚场深水区占满，再把下午场（含深水区预约 B-2065 迁移单）延期到晚场
const lockFull = await api('/locks', ops, {
  sessionId: 's-eve', zoneId: 'deep', reason: 'private_event',
  title: '满员测试包场', contactName: '测试', contactPhone: '13900000000', capacity: 30, isCommercial: false,
});
check('锁区占满晚场深水区', lockFull.status === 201, lockFull.data?.error);
const fullTarget = await api('/pool-status', ops, {
  sessionId: 's-pm', status: 'closed', disposition: 'postponed', cause: 'other',
  reason: '尝试延期到满员晚场', postponeToSessionId: 's-eve',
  refund: false, compVoucher: false, notifyResidents: false, requireWaterRetest: false,
});
check('目标场容量不足时拒绝延期', fullTarget.status === 409 && /容量不足/.test(fullTarget.data.error || ''), fullTarget.data.error);
st = await state(ops);
check('满员拒绝后下午场仍正常、迁移预约未变死单', st.sessions.find(s => s.id === 's-pm').poolStatus === 'normal' && st.bookings.find(b => b.id === migrated.id)?.status === 'checked_in');
// 释放锁区，避免污染后续
const lockId = lockFull.data?.lock?.id;
if (lockId) await api(`/locks/${lockId}`, ops, undefined, 'DELETE');

// 6.2 目标已闭池
r = await api('/bookings', li, {
  kind: 'parent_child', sessionId: 's-am', zoneId: 'shallow', age: 35, healthPledge: true,
  withChildren: true, childCount: 1, swimLevel: 'beginner', paymentMethod: 'wallet',
});
const closeEve = await api('/pool-status', ops, {
  sessionId: 's-eve', status: 'closed', disposition: 'closed', cause: 'other',
  reason: '晚场预先闭池', refund: false, compVoucher: false, notifyResidents: false, requireWaterRetest: false,
});
check('晚场可先闭池（构造已关闭目标）', closeEve.status === 200, closeEve.data?.error);
const bad = await api('/pool-status', ops, {
  sessionId: 's-pm', status: 'closed', disposition: 'postponed', cause: 'other',
  reason: '尝试延期到已关闭晚场', postponeToSessionId: 's-eve',
  refund: false, compVoucher: false, notifyResidents: false, requireWaterRetest: false,
});
check('目标场已闭池时拒绝延期', bad.status === 409 && /已闭池|部分开放/.test(bad.data.error || ''), bad.data.error);
st = await state(ops);
check('拒绝后下午场状态不变（仍正常）', st.sessions.find(s => s.id === 's-pm').poolStatus === 'normal');
check('拒绝后迁移的新预约仍是 booked（未变成 postponed 死单）', st.bookings.find(b => b.id === migrated.id)?.status === 'checked_in');

console.log('⑦ 费用与档案可追溯（迁移不产生退款流水/二次扣款）');
const txnsZhang = (await state(zhang)).walletTxns.filter(t => t.closureId === rec.id);
check('延期迁移不产生闭池退款流水', txnsZhang.length === 0, `n=${txnsZhang.length}`);
const rec2 = st.closureRecords.find(x => x.id === rec.id);
check('闭池档案保留原预约与新预约关联', rec2.affected.some(a => a.bookingId === origId && a.migratedBookingId === migrated.id));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('失败项：', fails); process.exit(1); }
