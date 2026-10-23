import { inject, Injectable } from '@angular/core';
import { AdminApi, ApiError } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';

/** The privacy routes' extras that AdminApi does not cover: downloading the export ZIP. */
@Injectable({ providedIn: 'root' })
export class PrivacyApi {
  private readonly api = inject(AdminApi);
  private readonly auth = inject(AuthService);

  /** Downloads a customer's data (ZIP with data.json and media/) and saves it in the browser. */
  async exportCustomer(contactId: string): Promise<void> {
    const url = `/api/admin/clients/${encodeURIComponent(this.api.clientId ?? '')}/privacy/customers/${encodeURIComponent(contactId)}/export`;
    const token = this.auth.token();
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new ApiError(
        res.status,
        detail.error ?? 'http_error',
        detail.message ?? `A exportação falhou (${res.status}).`,
      );
    }
    const name =
      /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
      'dados-cliente.zip';
    const href = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = href;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
}
