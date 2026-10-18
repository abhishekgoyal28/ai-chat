import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, ErrorAlert, Field, fieldError, formatDate, Loading, Modal, PageHeader, StatusBadge, useToast } from '../components/ui';
import { api, Role } from '../lib/api';

interface Member {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'ACTIVE' | 'DISABLED';
  lastLoginAt: string | null;
}

export const TeamPage = () => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const members = useQuery({ queryKey: ['team'], queryFn: () => api.get<Member[]>('/team') });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: '', name: '', role: 'EDITOR' as Role, password: '' });
  const [error, setError] = useState<unknown>(null);

  const add = async () => {
    setError(null);
    try {
      await api.post('/team', form);
      setAdding(false);
      setForm({ email: '', name: '', role: 'EDITOR', password: '' });
      await queryClient.invalidateQueries({ queryKey: ['team'] });
      toast('Member added — share the password with them securely');
    } catch (caught) {
      setError(caught);
    }
  };

  const update = async (member: Member, patch: Partial<Pick<Member, 'role' | 'status'>> & { password?: string }) => {
    try {
      await api.put(`/team/${member.id}`, patch);
      await queryClient.invalidateQueries({ queryKey: ['team'] });
      toast('Updated');
    } catch (caught) {
      toast((caught as Error).message, 'error');
    }
  };

  const resetPassword = (member: Member) => {
    const password = window.prompt(`New password for ${member.email} (at least 10 characters)`);
    if (password) {
      void update(member, { password });
    }
  };

  return (
    <>
      <PageHeader
        title="Team"
        description="Admins manage everything. Editors manage agents, personas, prompts, knowledge and conversations, but not providers, API keys, team or settings."
        actions={<button className="primary" onClick={() => setAdding(true)}>Add member</button>}
      />
      {members.isLoading ? (
        <Loading />
      ) : (
        <Card>
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.data?.map((member) => (
                <tr key={member.id}>
                  <td>
                    <strong>{member.name}</strong>
                    <div className="muted">{member.email}</div>
                  </td>
                  <td>
                    <select value={member.role} onChange={(event) => void update(member, { role: event.target.value as Role })} style={{ width: 120 }}>
                      <option value="ADMIN">Admin</option>
                      <option value="EDITOR">Editor</option>
                      <option value="GUEST">Guest</option>
                    </select>
                  </td>
                  <td>
                    <StatusBadge status={member.status} />
                  </td>
                  <td className="muted">{formatDate(member.lastLoginAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button className="small" onClick={() => resetPassword(member)}>
                        Reset password
                      </button>
                      <button className="small" onClick={() => void update(member, { status: member.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })}>
                        {member.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {adding && (
        <Modal
          title="Add team member"
          onClose={() => setAdding(false)}
          actions={
            <>
              <button onClick={() => setAdding(false)}>Cancel</button>
              <button className="primary" onClick={() => void add()}>
                Add
              </button>
            </>
          }
        >
          <ErrorAlert error={error} />
          <div className="grid-2">
            <Field label="Name" error={fieldError(error, 'name')}>
              <input type="text" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Field>
            <Field label="Email" error={fieldError(error, 'email')}>
              <input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
            </Field>
          </div>
          <div className="grid-2">
            <Field label="Role">
              <select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Role })}>
                <option value="EDITOR">Editor</option>
                <option value="ADMIN">Admin</option>
              </select>
            </Field>
            <Field label="Initial password" hint="At least 10 characters. They can change it under Account." error={fieldError(error, 'password')}>
              <input type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
};
