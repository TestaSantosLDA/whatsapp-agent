import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  KNOWLEDGE_ACCEPT,
  KNOWLEDGE_MAX_BYTES,
  knowledgeFileType,
  type KnowledgeDocumentView,
} from '@wa/shared';
import { AdminApi, ApiError } from '../../core/api.service';
import { SessionStore } from '../../core/session.store';
import { fileSize, shortDate, statusLabel, typeLabel } from './knowledge.format';

/** How often the list refreshes while a file is being read. */
const POLL_MS = 3000;

/** Conhecimento (WA-026): drop files, see each one's status, open one to review. */
@Component({
  selector: 'app-knowledge-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="page">
      <header class="page__head">
        <h1 class="page__title">Conhecimento</h1>
        <p class="muted small kb-intro">
          Fichas técnicas, tabelas de preços e catálogos. O assistente pesquisa-os para responder a
          perguntas técnicas e cita o documento. Os dados de produto lidos (m² por caixa, peso,
          dimensões…) só são usados depois de aprovados.
        </p>
      </header>

      <div class="stack">
        @if (session.isAdmin()) {
          <label
            class="dropzone"
            [class.dropzone--over]="over()"
            (dragover)="dragOver($event)"
            (dragleave)="over.set(false)"
            (drop)="drop($event)"
          >
            <input
              class="sr-only"
              type="file"
              multiple
              [accept]="accept"
              (change)="picked($event)"
            />
            <svg class="dropzone__icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
            </svg>
            <span class="dropzone__title">Largue ficheiros aqui ou <u>escolha</u></span>
            <span class="muted small">PDF, Excel, CSV, Word ou imagem · até {{ maxMb }} MB</span>
          </label>
        }

        @for (u of uploads(); track u.name) {
          <p class="notice" [class.notice--error]="u.error" role="status">
            {{ u.name }}: {{ u.error ?? 'a enviar…' }}
          </p>
        }
        @if (error()) {
          <p class="notice notice--error" role="alert">{{ error() }}</p>
        }

        @if (loaded() && documents().length === 0) {
          <div class="card empty">
            <p class="empty__text">Ainda não há documentos.</p>
            @if (!session.isAdmin()) {
              <p class="muted small">Os administradores podem adicionar ficheiros aqui.</p>
            }
          </div>
        } @else {
          <ul class="kb-list card" aria-label="Documentos">
            @for (d of documents(); track d.id) {
              <li class="kb-doc">
                <a class="kb-doc__link" [routerLink]="d.id">
                  <span class="kb-doc__type" [attr.data-type]="d.type">{{ d.type }}</span>
                  <span class="kb-doc__main">
                    <span class="kb-doc__name">{{ d.name }}</span>
                    <span class="muted small">
                      {{ typeLabel(d) }} · {{ fileSize(d.sizeBytes) }} ·
                      {{ shortDate(d.createdAt) }}
                      @if (d.passages) {
                        · {{ d.passages }} {{ d.passages === 1 ? 'excerto' : 'excertos' }}
                      }
                    </span>
                    @if (d.error) {
                      <span class="small kb-doc__error">{{ d.error }}</span>
                    }
                  </span>
                  <span class="status" [attr.data-status]="d.status">{{ statusLabel(d) }}</span>
                </a>
              </li>
            }
          </ul>
        }
      </div>
    </section>
  `,
})
export class KnowledgePage {
  private readonly api = inject(AdminApi);
  protected readonly session = inject(SessionStore);

  protected readonly accept = KNOWLEDGE_ACCEPT;
  protected readonly maxMb = KNOWLEDGE_MAX_BYTES / 1024 / 1024;
  protected readonly statusLabel = statusLabel;
  protected readonly typeLabel = typeLabel;
  protected readonly fileSize = fileSize;
  protected readonly shortDate = shortDate;

  protected readonly documents = signal<KnowledgeDocumentView[]>([]);
  protected readonly loaded = signal(false);
  protected readonly over = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly uploads = signal<{ name: string; error: string | null }[]>([]);
  private readonly processing = computed(() =>
    this.documents().some((d) => d.status === 'processing'),
  );
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
    void this.load();
  }

  protected dragOver(event: DragEvent): void {
    event.preventDefault();
    this.over.set(true);
  }

  protected drop(event: DragEvent): void {
    event.preventDefault();
    this.over.set(false);
    void this.upload([...(event.dataTransfer?.files ?? [])]);
  }

  protected picked(event: Event): void {
    const input = event.target as HTMLInputElement;
    void this.upload([...(input.files ?? [])]);
    input.value = '';
  }

  private async upload(files: File[]): Promise<void> {
    for (const file of files) {
      const problem = !knowledgeFileType(file.name)
        ? 'tipo de ficheiro não suportado.'
        : file.size > KNOWLEDGE_MAX_BYTES
          ? `maior do que ${this.maxMb} MB.`
          : null;
      this.uploads.update((u) => [
        ...u.filter((x) => x.name !== file.name),
        { name: file.name, error: problem },
      ]);
      if (problem) continue;
      const form = new FormData();
      form.set('file', file, file.name);
      try {
        const doc = await this.api.client<KnowledgeDocumentView>(
          'POST',
          '/knowledge/documents',
          form,
        );
        this.documents.update((list) => [doc, ...list]);
        this.uploads.update((u) => u.filter((x) => x.name !== file.name));
      } catch (e) {
        const message = e instanceof ApiError ? e.message : 'Não foi possível enviar.';
        this.uploads.update((u) =>
          u.map((x) => (x.name === file.name ? { ...x, error: message } : x)),
        );
      }
    }
    this.schedule();
  }

  private async load(): Promise<void> {
    try {
      this.documents.set(
        await this.api.client<KnowledgeDocumentView[]>('GET', '/knowledge/documents'),
      );
      this.error.set(null);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : 'Não foi possível contactar o servidor.');
    } finally {
      this.loaded.set(true);
    }
    this.schedule();
  }

  /** Refreshes while something is being read, so the status changes without a reload. */
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.processing()) this.timer = setTimeout(() => void this.load(), POLL_MS);
  }
}
