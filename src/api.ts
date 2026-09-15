import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  LoginReq, LoginResp, User, CreateBookingReq, CheckInReq, WaterReadingReq,
  PatrolReq, IncidentCreateReq, IncidentActionReq, PoolStatusReq, WorkTaskReq,
  ComplaintReq, RechargeReq, GuardDutyReq, GuardReliefReq, LockReq,
} from '../shared/types.js';

const TOKEN_KEY = 'pool-token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `请求失败 (${res.status})`);
  return data as T;
}

export interface AppState {
  users: User[];
  zones: import('../shared/types.js').Zone[];
  sessions: import('../shared/types.js').Session[];
  bookings: import('../shared/types.js').Booking[];
  waterReadings: import('../shared/types.js').WaterReading[];
  equipment: import('../shared/types.js').Equipment[];
  guardDuties: import('../shared/types.js').GuardDuty[];
  patrolIssues: import('../shared/types.js').PatrolIssue[];
  incidents: import('../shared/types.js').Incident[];
  workTasks: import('../shared/types.js').WorkTask[];
  complaints: import('../shared/types.js').Complaint[];
  notifications: import('../shared/types.js').Notification[];
  walletTxns: import('../shared/types.js').WalletTxn[];
  lessons: import('../shared/types.js').CoachingLesson[];
  boards: import('../shared/types.js').LiveBoard[];
  conflicts: { sessionId: string; sessionLabel: string; message: string }[];
}

export function useLogin() {
  return useMutation({
    mutationFn: (body: LoginReq) => api<LoginResp>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  });
}

export function useStateQuery() {
  return useQuery({
    queryKey: ['state'],
    queryFn: () => api<AppState>('/state'),
    refetchInterval: 4000,
  });
}

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<{ user: User; zoneConflicts: any[] }>('/me') });
}

/** 所有写操作统一走这个 hook，成功后刷新全局状态 */
export function useAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, method = 'POST', body }: { path: string; method?: string; body?: unknown }) =>
      api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['state'] }),
  });
}

export type { CreateBookingReq, CheckInReq, WaterReadingReq, PatrolReq, IncidentCreateReq, IncidentActionReq, PoolStatusReq, WorkTaskReq, ComplaintReq, RechargeReq, GuardDutyReq, GuardReliefReq, LockReq };
