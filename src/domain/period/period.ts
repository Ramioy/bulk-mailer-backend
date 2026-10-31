import { DomainError } from '../shared/domain-error';

const SPANISH_MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
] as const;

const PERIOD_PATTERN = /^(?<year>\d{4})-(?<month>0[1-9]|1[0-2])$/;

/** Billing month, written `YYYY-MM` (e.g. `2026-10`). */
export class Period {
  private constructor(
    readonly year: number,
    readonly month: number,
  ) {}

  static of(year: number, month: number): Period {
    if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new DomainError(`Invalid period year: ${year}`);
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new DomainError(`Invalid period month: ${month}`);
    return new Period(year, month);
  }

  /** Returns `undefined` when the text is not a `YYYY-MM` period. */
  static parse(text: string): Period | undefined {
    const groups = PERIOD_PATTERN.exec(text)?.groups;
    if (!groups) return undefined;
    return Period.of(Number(groups.year), Number(groups.month));
  }

  /** Calendar month of `now` in the given IANA time zone. */
  static current(now: Date, timeZone: string): Period {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(now);
    const value = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    return Period.of(value('year'), value('month'));
  }

  /** Only the current period and the previous one can be operated. */
  static isOperable(period: Period, now: Date, timeZone: string): boolean {
    const current = Period.current(now, timeZone);
    return period.equals(current) || period.equals(current.previous());
  }

  previous(): Period {
    return this.month === 1 ? Period.of(this.year - 1, 12) : Period.of(this.year, this.month - 1);
  }

  equals(other: Period): boolean {
    return this.year === other.year && this.month === other.month;
  }

  toString(): string {
    return `${this.year}-${String(this.month).padStart(2, '0')}`;
  }

  /** Spanish label used in the email subject, e.g. `Octubre 2026`. */
  label(): string {
    return `${SPANISH_MONTHS[this.month - 1]} ${this.year}`;
  }
}
