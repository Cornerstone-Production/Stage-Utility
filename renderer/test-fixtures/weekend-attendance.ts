// weekend-attendance.ts — three recorded Weekend services, the least history
// Home's Recent services card needs to draw: it renders nothing until something
// is recorded, and its chart nothing below two points.

export const WEEKEND_ATTENDANCE: ServiceAttendance[] = ["2026-08-16", "2026-08-23", "2026-08-30"].map((day, i) => ({
  serviceKey: `st-1:plan-${day}:${day}`,
  serviceTypeId: "st-1",
  serviceTypeName: "Weekend",
  planId: `plan-${day}`,
  planTitle: "Sample plan",
  seriesTitle: null,
  serviceDate: day,
  serviceTimeId: null,
  serviceTimeStartsAt: `${day}T15:00:00.000Z`,
  startedAt: `${day}T15:00:00.000Z`,
  endedAt: `${day}T16:30:00.000Z`,
  samples: [],
  attendanceBaseline: 0,
  totalAttendance: 200 + i * 10,
  peakAttendance: 200 + i * 10,
  peakOccupancy: 200 + i * 10,
  minOccupancy: 0,
  lastAttendance: 200 + i * 10,
  lastOccupancy: 200 + i * 10,
}));
