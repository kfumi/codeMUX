use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveTime, TimeZone, Timelike, Utc};

use super::types::ScheduleKind;

fn parse_schedule_time(schedule_time: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(schedule_time, "%H:%M").ok()
}

fn clamp_monthly_day(year: i32, month: u32, monthly_day: i32) -> u32 {
    let last_day = last_day_of_month(year, month);
    monthly_day.clamp(1, last_day as i32) as u32
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    }
    .map(|date| date.pred_opt().map(|d| d.day()).unwrap_or(28))
    .unwrap_or(28)
}

fn is_weekday(date: NaiveDate) -> bool {
    matches!(date.weekday(), chrono::Weekday::Mon | chrono::Weekday::Tue | chrono::Weekday::Wed | chrono::Weekday::Thu | chrono::Weekday::Fri)
}

fn local_from_naive(date: NaiveDate, time: NaiveTime) -> DateTime<Local> {
    Local
        .from_local_datetime(&date.and_time(time))
        .single()
        .unwrap_or_else(|| Local.from_utc_datetime(&date.and_time(time)))
}

pub fn compute_next_run_at(
    schedule_kind: ScheduleKind,
    schedule_time: &str,
    weekly_weekday: Option<i32>,
    monthly_day: Option<i32>,
    from: DateTime<Utc>,
) -> DateTime<Utc> {
    let from_local = from.with_timezone(&Local);
    match schedule_kind {
        ScheduleKind::Hourly => {
            let next_hour = if from_local.minute() == 0 && from_local.second() == 0 && from_local.nanosecond() == 0 {
                from_local
            } else {
                from_local
                    + chrono::Duration::hours(1)
                    - chrono::Duration::minutes(from_local.minute() as i64)
                    - chrono::Duration::seconds(from_local.second() as i64)
                    - chrono::Duration::nanoseconds(from_local.nanosecond() as i64)
            };
            next_hour.with_timezone(&Utc)
        }
        ScheduleKind::Daily | ScheduleKind::Weekdays | ScheduleKind::Weekly | ScheduleKind::Monthly => {
            let time = parse_schedule_time(schedule_time).unwrap_or_else(|| NaiveTime::from_hms_opt(9, 0, 0).unwrap());
            let mut date = from_local.date_naive();
            for _ in 0..400 {
                let candidate_date = match schedule_kind {
                    ScheduleKind::Daily => date,
                    ScheduleKind::Weekdays => {
                        if is_weekday(date) {
                            date
                        } else {
                            date = date.succ_opt().unwrap_or(date);
                            continue;
                        }
                    }
                    ScheduleKind::Weekly => {
                        let target = weekly_weekday.unwrap_or(1).clamp(0, 6) as u32;
                        let current = date.weekday().num_days_from_monday();
                        let target_monday = target;
                        if current == target_monday {
                            date
                        } else {
                            let days_ahead = (target_monday as i32 - current as i32 + 7) % 7;
                            if days_ahead == 0 {
                                date
                            } else {
                                date = date + chrono::Duration::days(days_ahead as i64);
                                continue;
                            }
                        }
                    }
                    ScheduleKind::Monthly => {
                        let day = monthly_day.unwrap_or(1);
                        let clamped = clamp_monthly_day(date.year(), date.month(), day);
                        NaiveDate::from_ymd_opt(date.year(), date.month(), clamped).unwrap_or(date)
                    }
                    ScheduleKind::Hourly => unreachable!(),
                };

                let candidate = local_from_naive(candidate_date, time);
                if candidate > from_local {
                    return candidate.with_timezone(&Utc);
                }

                date = match schedule_kind {
                    ScheduleKind::Daily => date.succ_opt().unwrap_or(date),
                    ScheduleKind::Weekdays => {
                        let mut next = date.succ_opt().unwrap_or(date);
                        while !is_weekday(next) {
                            next = next.succ_opt().unwrap_or(next);
                        }
                        next
                    }
                    ScheduleKind::Weekly => date + chrono::Duration::days(7),
                    ScheduleKind::Monthly => {
                        let (year, month) = if date.month() == 12 {
                            (date.year() + 1, 1)
                        } else {
                            (date.year(), date.month() + 1)
                        };
                        let day = monthly_day.unwrap_or(1);
                        let clamped = clamp_monthly_day(year, month, day);
                        NaiveDate::from_ymd_opt(year, month, clamped).unwrap_or(date)
                    }
                    ScheduleKind::Hourly => unreachable!(),
                };
            }
            from
        }
    }
}

pub fn local_timezone_label() -> String {
    let now = Local::now();
    now.format("%:z").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn utc(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        Local
            .from_local_datetime(
                &NaiveDate::from_ymd_opt(y, m, d)
                    .unwrap()
                    .and_hms_opt(h, min, 0)
                    .unwrap(),
            )
            .single()
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn monthly_day_31_falls_on_last_day_of_short_month() {
        let from = utc(2026, 1, 31, 10, 0);
        let next = compute_next_run_at(ScheduleKind::Monthly, "09:00", None, Some(31), from);
        let next_local = next.with_timezone(&Local);
        assert_eq!(next_local.month(), 2);
        assert_eq!(next_local.day(), 28);
        assert_eq!(next_local.hour(), 9);
    }

    #[test]
    fn weekdays_skip_weekend() {
        let from = utc(2026, 8, 27, 10, 0);
        let next = compute_next_run_at(ScheduleKind::Weekdays, "09:00", None, None, from);
        let next_local = next.with_timezone(&Local);
        assert!(is_weekday(next_local.date_naive()));
        assert!(next_local > from.with_timezone(&Local));
    }

    #[test]
    fn hourly_moves_to_next_hour_boundary() {
        let from = utc(2026, 8, 27, 10, 15);
        let next = compute_next_run_at(ScheduleKind::Hourly, "00:00", None, None, from);
        let next_local = next.with_timezone(&Local);
        assert_eq!(next_local.hour(), 11);
        assert_eq!(next_local.minute(), 0);
    }
}
