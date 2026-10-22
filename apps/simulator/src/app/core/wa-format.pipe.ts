import { Pipe, PipeTransform } from '@angular/core';
import { formatTime, formatWhatsApp } from './wa-format';

/** `{{ text | waFormat }}` for [innerHTML]: escapes HTML, then applies *bold*, _italic_, ~strike~, ```mono``` and links. */
@Pipe({ name: 'waFormat' })
export class WaFormatPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return formatWhatsApp(value);
  }
}

/** HH:MM in local time. */
@Pipe({ name: 'waTime' })
export class WaTimePipe implements PipeTransform {
  transform(value: string | number | null | undefined): string {
    return value == null ? '' : formatTime(value);
  }
}
