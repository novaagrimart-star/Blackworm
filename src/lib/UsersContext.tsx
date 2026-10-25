import React, { createContext, useContext, useState, useEffect } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { UserProfile } from './auth';

interface UsersContextType {
  users: UserProfile[];
  loading: boolean;
  error: string | null;
  refreshUsers: () => Promise<void>;
}

const UsersContext = createContext<UsersContextType | undefined>(undefined);

export const UsersProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, 'users'));
      const list: UserProfile[] = [];
      snap.forEach(d => {
        const userData = d.data() as UserProfile;
        list.push({ ...userData, uid: d.id });
      });
      list.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
      setUsers(list);
      setError(null);
    } catch (err: any) {
      console.error('Error fetching users:', err);
      setError(err.message || 'Failed to fetch users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  return (
    <UsersContext.Provider value={{ users, loading, error, refreshUsers: fetchUsers }}>
      {children}
    </UsersContext.Provider>
  );
};

export const useUsers = () => {
  const context = useContext(UsersContext);
  if (context === undefined) {
    throw new Error('useUsers must be used within a UsersProvider');
  }
  return context;
};
