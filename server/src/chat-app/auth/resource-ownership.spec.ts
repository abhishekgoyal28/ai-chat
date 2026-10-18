import { AdminUser, KnowledgeBase, Persona, Prompt } from '../../shared/database/entities';
import { AdminRole, PromptKind, RecordStatus } from '../../shared/domain/enums';
import { ForbiddenError, UnauthorizedError } from '../../shared/errors/app-errors';
import { AgentRuntimeService } from '../agents/agent-runtime.service';
import { AgentAdminRepository, KnowledgeRepository, PersonaRepository, PromptRepository } from '../admin/repositories/config.repositories';
import { KnowledgeAdminService } from '../admin/services/knowledge-admin.service';
import { PersonaAdminService } from '../admin/services/persona-admin.service';
import { PromptAdminService } from '../admin/services/prompt-admin.service';
import { RevisionRecorder } from '../admin/services/revision-recorder.service';
import { AdminAuthService, AdminPrincipal } from './admin-auth.service';
import { AdminUserRepository } from './admin-user.repository';
import { GoogleOAuthClient, GoogleProfile } from './google-oauth.client';
import { canModify } from './resource-ownership';

const admin: AdminPrincipal = { id: '1', email: 'admin@example.com', name: 'Admin', role: AdminRole.ADMIN };
const editor: AdminPrincipal = { id: '2', email: 'editor@example.com', name: 'Editor', role: AdminRole.EDITOR };
const guest: AdminPrincipal = { id: '10', email: 'guest@example.com', name: 'Guest', role: AdminRole.GUEST };
const otherGuest: AdminPrincipal = { id: '11', email: 'other@example.com', name: 'Other', role: AdminRole.GUEST };

const revisions = { record: jest.fn().mockResolvedValue(undefined) } as unknown as RevisionRecorder;
const runtime = { invalidate: jest.fn() } as unknown as AgentRuntimeService;

describe('canModify', () => {
  it('lets admins and editors change anything, owned or not', () => {
    expect(canModify(admin, { createdById: null })).toBe(true);
    expect(canModify(editor, { createdById: guest.id })).toBe(true);
  });

  it('lets a guest change only what they created', () => {
    expect(canModify(guest, { createdById: guest.id })).toBe(true);
    expect(canModify(guest, { createdById: otherGuest.id })).toBe(false);
  });

  it('treats unowned (seeded or pre-ownership) items as read-only for guests', () => {
    expect(canModify(guest, { createdById: null })).toBe(false);
  });
});

describe('ownership enforcement in admin services', () => {
  const persona = (createdById: string | null): Persona => ({ id: '5', name: 'P', displayName: 'P', avatarUrl: null, tagline: null, prompt: 'x', createdById, revision: 1 }) as Persona;

  const personaService = (row: Persona) => {
    const personas = {
      findById: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockImplementation(async (values: Partial<Persona>) => ({ ...row, ...values, id: '6' })),
    };
    const agents = { countByPersona: jest.fn().mockResolvedValue(0) };
    const service = new PersonaAdminService(personas as unknown as PersonaRepository, agents as unknown as AgentAdminRepository, runtime, revisions);
    return { service, personas };
  };

  const personaInput = { name: 'P', displayName: 'P', avatarUrl: null, tagline: null, prompt: 'x' };

  it('records the creator on create', async () => {
    const { service, personas } = personaService(persona(null));
    await service.create(personaInput, guest);
    expect(personas.create).toHaveBeenCalledWith(expect.objectContaining({ createdById: guest.id }));
  });

  it('refuses a guest updating or deleting someone else’s persona, without writing', async () => {
    const { service, personas } = personaService(persona(otherGuest.id));
    await expect(service.update('5', { ...personaInput, expectedRevision: 1 }, guest)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.delete('5', guest)).rejects.toBeInstanceOf(ForbiddenError);
    expect(personas.update).not.toHaveBeenCalled();
    expect(personas.delete).not.toHaveBeenCalled();
  });

  it('lets a guest update and delete their own persona', async () => {
    const { service, personas } = personaService(persona(guest.id));
    await service.update('5', { ...personaInput, expectedRevision: 1 }, guest);
    await service.delete('5', guest);
    expect(personas.update).toHaveBeenCalled();
    expect(personas.delete).toHaveBeenCalledWith('5');
  });

  it('keeps the master prompt read-only for guests', async () => {
    const master = { id: '1', kind: PromptKind.MASTER, name: 'Master', description: null, text: 't', createdById: null, revision: 3 } as Prompt;
    const prompts = { findMaster: jest.fn().mockResolvedValue(master), update: jest.fn() };
    const service = new PromptAdminService(prompts as unknown as PromptRepository, {} as AgentAdminRepository, revisions);
    await expect(service.updateMaster({ text: 'new', expectedRevision: 3 }, guest)).rejects.toBeInstanceOf(ForbiddenError);
    expect(prompts.update).not.toHaveBeenCalled();
  });

  it('applies the knowledge base owner to its documents', async () => {
    const base = { id: '7', name: 'KB', description: null, createdById: otherGuest.id, revision: 1 } as KnowledgeBase;
    const knowledge = { findBase: jest.fn().mockResolvedValue(base), createDocument: jest.fn(), deleteDocument: jest.fn() };
    const service = new KnowledgeAdminService(knowledge as unknown as KnowledgeRepository, {} as AgentAdminRepository, revisions);
    await expect(service.createDocument('7', { title: 'Doc', content: 'text', status: RecordStatus.ACTIVE }, guest)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.deleteDocument('7', '9', guest)).rejects.toBeInstanceOf(ForbiddenError);
    expect(knowledge.createDocument).not.toHaveBeenCalled();
    expect(knowledge.deleteDocument).not.toHaveBeenCalled();
  });
});

describe('Google sign-in', () => {
  const profile: GoogleProfile = { sub: 'g-1', email: 'new@example.com', emailVerified: true, name: 'New Person' };

  const setup = (existing: AdminUser | null, googleProfile: GoogleProfile = profile) => {
    const users = {
      findByEmail: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockImplementation(async (values: Partial<AdminUser>) => ({ ...values, id: '42', status: RecordStatus.ACTIVE }) as AdminUser),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const google = {
      isConfigured: () => true,
      authorizationUrl: (state: string) => `https://google.test/auth?state=${state}`,
      fetchProfile: jest.fn().mockResolvedValue(googleProfile),
    };
    const service = new AdminAuthService(users as unknown as AdminUserRepository, google as unknown as GoogleOAuthClient);
    const { url, nonce } = service.beginGoogleSignIn();
    const state = new URL(url).searchParams.get('state') ?? '';
    return { service, users, google, state, nonce };
  };

  it('creates a GUEST account on first sign-in', async () => {
    const { service, users, state, nonce } = setup(null);
    const { principal, token } = await service.completeGoogleSignIn('code', state, nonce);
    expect(users.create).toHaveBeenCalledWith(expect.objectContaining({ email: profile.email, name: 'New Person', role: AdminRole.GUEST }));
    expect(principal.role).toBe(AdminRole.GUEST);
    expect(token).toBeTruthy();
  });

  it('signs an existing member in with their own role', async () => {
    const existing = { id: '2', email: 'new@example.com', name: 'Editor', role: AdminRole.EDITOR, status: RecordStatus.ACTIVE } as AdminUser;
    const { service, users, state, nonce } = setup(existing);
    const { principal } = await service.completeGoogleSignIn('code', state, nonce);
    expect(principal.role).toBe(AdminRole.EDITOR);
    expect(users.create).not.toHaveBeenCalled();
  });

  it('rejects a callback from a browser that did not start the sign-in', async () => {
    const { service, google, state } = setup(null);
    await expect(service.completeGoogleSignIn('code', state, 'someone-elses-nonce')).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.completeGoogleSignIn('code', state, undefined)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(google.fetchProfile).not.toHaveBeenCalled();
  });

  it('rejects a forged state', async () => {
    const { service, nonce } = setup(null);
    await expect(service.completeGoogleSignIn('code', 'not.a.token', nonce)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an unverified Google email and a disabled account', async () => {
    const unverified = setup(null, { ...profile, emailVerified: false });
    await expect(unverified.service.completeGoogleSignIn('code', unverified.state, unverified.nonce)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(unverified.users.create).not.toHaveBeenCalled();

    const disabled = setup({ id: '3', email: profile.email, name: 'X', role: AdminRole.GUEST, status: RecordStatus.DISABLED } as AdminUser);
    await expect(disabled.service.completeGoogleSignIn('code', disabled.state, disabled.nonce)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
