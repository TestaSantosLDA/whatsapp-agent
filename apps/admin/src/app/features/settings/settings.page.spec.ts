import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AdminSettingsView, ClientSettings } from '@wa/shared';
import { AdminApi } from '../../core/api.service';
import { json } from '../../testing';
import { buildSettingsForm, formToSettings, splitList } from './settings.form';
import { SettingsPage } from './settings.page';

const settings: ClientSettings = {
  response_time: 'um dia útil',
  response_time_hours: 8,
  handoff_triggers: ['Obras acima de 500 m²'],
  branches: [
    {
      id: 'maia',
      lead_emails: ['maia@example.invalid'],
      hours: { mon: ['08:30-12:30', '14:00-18:30'], sat: ['10:00-13:00'] },
    },
    { id: 'albufeira', lead_emails: [], hours: { mon: ['09:00-18:00'] } },
  ],
};
const view = (s: ClientSettings, overridden: string[] = []): AdminSettingsView => ({
  settings: s,
  defaults: settings,
  overridden,
  branches: [
    { id: 'maia', name: 'Norte (Maia)', region: 'Norte' },
    { id: 'albufeira', name: 'Sul (Albufeira)', region: 'Algarve' },
  ],
  updatedAt: null,
  updatedBy: null,
});

describe('settings form', () => {
  it('round-trips the settings, one email per line and hours per day', () => {
    const form = buildSettingsForm(settings);
    expect(form.controls.branches.at(0).controls.hours.controls.mon.value).toBe(
      '08:30-12:30, 14:00-18:30',
    );
    expect(form.controls.branches.at(0).controls.hours.controls.sun.value).toBe('');
    expect(formToSettings(form)).toEqual(settings);
  });

  it('validates emails and opening hours with the shared schema', () => {
    const form = buildSettingsForm(settings);
    const maia = form.controls.branches.at(0).controls;
    maia.lead_emails.setValue('ok@example.pt\nnot-an-email');
    expect(maia.lead_emails.errors).toEqual({ emails: ['not-an-email'] });
    maia.lead_emails.setValue('A@Example.pt, b@example.pt');
    expect(maia.lead_emails.valid).toBe(true);
    maia.hours.controls.tue.setValue('18:00-09:00');
    expect(maia.hours.controls.tue.invalid).toBe(true);
    maia.hours.controls.tue.setValue('9:00-12:00');
    expect(maia.hours.controls.tue.invalid).toBe(true);
    maia.hours.controls.tue.setValue('09:00-12:00');
    expect(form.valid).toBe(true);
    expect(formToSettings(form).branches[0]).toMatchObject({
      lead_emails: ['a@example.pt', 'b@example.pt'],
      hours: { mon: ['08:30-12:30', '14:00-18:30'], tue: ['09:00-12:00'], sat: ['10:00-13:00'] },
    });
    form.controls.response_time.setValue('');
    expect(form.invalid).toBe(true);
    expect(splitList(' a ;b,\n\nc ')).toEqual(['a', 'b', 'c']);
  });
});

describe('SettingsPage', () => {
  let requests: { method: string; url: string; body: unknown }[];

  beforeEach(() => {
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ method, url, body });
        if (method === 'PUT') return json(view(body, ['branches.albufeira.lead_emails']));
        return json(view(settings));
      }),
    );
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.inject(AdminApi).clientId = 'jular';
  });
  afterEach(() => vi.unstubAllGlobals());

  async function render() {
    const fixture = TestBed.createComponent(SettingsPage);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('loads the branches and saves a new lead recipient for one of them', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/api/admin/clients/jular/settings' });
    const titles = [...el.querySelectorAll('.card__title')].map((h) => h.textContent?.trim());
    expect(titles).toEqual(['Atendimento', 'Norte (Maia)', 'Sul (Albufeira)']);

    const save = el.querySelector<HTMLButtonElement>('button[type=submit]')!;
    const emails = el.querySelector<HTMLTextAreaElement>('#le-1')!;
    emails.value = 'nope';
    emails.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(el.textContent).toContain('Email inválido: nope');
    expect(save.disabled).toBe(true);

    emails.value = 'albufeira@jular.pt';
    emails.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(save.disabled).toBe(false);
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();

    const put = requests.find((r) => r.method === 'PUT')!;
    expect(put.url).toBe('/api/admin/clients/jular/settings');
    expect((put.body as ClientSettings).branches[1]!.lead_emails).toEqual(['albufeira@jular.pt']);
    expect((put.body as ClientSettings).branches[0]).toEqual(settings.branches[0]);
    expect(el.textContent).toContain('Guardado.');
    expect(el.querySelectorAll('.tag')).toHaveLength(1);
  });
});
