import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import type { AdminMember, InviteResult, TeamRole } from '@wa/shared';
import { AdminApi, ApiError } from '../../core/api.service';
import { SessionStore } from '../../core/session.store';

const inviteNotes: Record<InviteResult['invite'], string> = {
  sent: 'Convite enviado por email.',
  already_registered: 'Esta pessoa já tem conta: pode entrar já com o email ou com o Google.',
  not_configured: 'Adicionado. O envio de convites não está configurado neste servidor.',
};

/** The team (admins, WA-022): invite, change role and branches, remove. */
@Component({
  selector: 'app-team-page',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'stack' },
  template: `
    <section class="card">
      <h2 class="card__title">Convidar</h2>
      <form [formGroup]="invite" (ngSubmit)="send()" class="invite">
        <input
          class="input"
          type="email"
          formControlName="email"
          placeholder="email@empresa.pt"
          aria-label="Email"
        />
        <input
          class="input"
          formControlName="name"
          placeholder="Nome (opcional)"
          aria-label="Nome"
        />
        <select class="input" formControlName="role" aria-label="Função">
          <option value="sales">Comercial</option>
          <option value="admin">Administrador</option>
        </select>
        <div class="chips" role="group" aria-label="Filiais">
          @for (b of session.context()?.allBranches ?? []; track b.id) {
            <label class="chip">
              <input type="checkbox" [checked]="picked().includes(b.id)" (change)="toggle(b.id)" />
              {{ b.name }}
            </label>
          }
        </div>
        <button type="submit" class="btn btn--primary" [disabled]="invite.invalid || busy()">
          Convidar
        </button>
      </form>
      @if (note()) {
        <p class="muted small" role="status">{{ note() }}</p>
      }
      @if (error()) {
        <p class="field__error" role="alert">{{ error() }}</p>
      }
    </section>

    <section class="card">
      <h2 class="card__title">Equipa</h2>
      <ul class="members">
        @for (m of members(); track m.id) {
          <li class="member">
            <div class="member__who">
              <div class="member__name">{{ m.name || m.email }}</div>
              <div class="muted small">
                {{ m.email }} · {{ m.status === 'invited' ? 'convite pendente' : 'ativo' }}
              </div>
            </div>
            <select
              class="input input--sm"
              [value]="m.role"
              (change)="setRole(m, $any($event.target).value)"
              aria-label="Função"
            >
              <option value="sales">Comercial</option>
              <option value="admin">Administrador</option>
            </select>
            <div class="chips">
              @for (b of session.context()?.allBranches ?? []; track b.id) {
                <label class="chip chip--sm">
                  <input
                    type="checkbox"
                    [checked]="m.branches.includes(b.id)"
                    (change)="toggleMemberBranch(m, b.id)"
                  />
                  {{ b.name }}
                </label>
              }
            </div>
            <div class="member__actions">
              @if (m.status === 'invited') {
                <button type="button" class="btn btn--sm" (click)="resend(m)">Reenviar</button>
              }
              @if (m.id !== session.context()?.member?.id) {
                <button type="button" class="btn btn--sm btn--danger" (click)="remove(m)">
                  Remover
                </button>
              }
            </div>
          </li>
        }
      </ul>
      <p class="muted small">
        Comerciais veem só as filiais assinaladas. Administradores veem tudo e recebem alertas das
        filiais assinaladas.
      </p>
    </section>
  `,
})
export class TeamPage {
  private readonly api = inject(AdminApi);
  protected readonly session = inject(SessionStore);

  protected readonly members = signal<AdminMember[]>([]);
  protected readonly picked = signal<string[]>([]);
  protected readonly busy = signal(false);
  protected readonly note = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly invite = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
    name: new FormControl('', { nonNullable: true }),
    role: new FormControl<TeamRole>('sales', { nonNullable: true }),
  });

  constructor() {
    void this.load();
  }

  protected toggle(id: string): void {
    this.picked.update((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  private async load(): Promise<void> {
    await this.run(async () => this.members.set(await this.api.client('GET', '/team')));
  }

  protected async send(): Promise<void> {
    const { email, name, role } = this.invite.getRawValue();
    await this.run(async () => {
      const result = await this.api.client<InviteResult>('POST', '/team', {
        email,
        name: name.trim() || undefined,
        role,
        branches: this.picked(),
      });
      this.note.set(inviteNotes[result.invite]);
      this.invite.reset({ email: '', name: '', role: 'sales' });
      this.picked.set([]);
      this.members.set(await this.api.client('GET', '/team'));
    });
  }

  protected setRole(m: AdminMember, role: TeamRole): Promise<void> {
    return this.patch(m, { role });
  }

  protected toggleMemberBranch(m: AdminMember, id: string): Promise<void> {
    const branches = m.branches.includes(id)
      ? m.branches.filter((b) => b !== id)
      : [...m.branches, id];
    return this.patch(m, { branches });
  }

  protected async resend(m: AdminMember): Promise<void> {
    await this.run(async () => {
      const result = await this.api.client<InviteResult>('POST', `/team/${m.id}/invite`);
      this.note.set(inviteNotes[result.invite]);
    });
  }

  protected async remove(m: AdminMember): Promise<void> {
    if (!confirm(`Remover ${m.name || m.email} da equipa?`)) return;
    await this.run(async () => {
      await this.api.client('DELETE', `/team/${m.id}`);
      this.members.update((list) => list.filter((x) => x.id !== m.id));
    });
  }

  private async patch(m: AdminMember, body: Partial<AdminMember>): Promise<void> {
    await this.run(async () => {
      const updated = await this.api.client<AdminMember>('PATCH', `/team/${m.id}`, body);
      this.members.update((list) => list.map((x) => (x.id === m.id ? updated : x)));
    });
    // A refused change (e.g. the last admin): show the controls as they really are again.
    const refused = this.error();
    if (refused) {
      this.members.set([]);
      await this.load();
      this.error.set(refused);
    }
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : 'Não foi possível contactar o servidor.');
    } finally {
      this.busy.set(false);
    }
  }
}
