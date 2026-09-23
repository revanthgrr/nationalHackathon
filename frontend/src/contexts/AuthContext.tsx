/**
 * AuthContext — manages authentication state for the two-role RailSetu frontend.
 *
 * Stores JWT token and user profile in localStorage for persistence.
 * Provides login/logout functions and role-based access helpers.
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import type { LoginResponse, UserProfile } from '../types/api';
import { login as apiLogin, getMe, setAuthToken, getAuthToken, clearAuthToken } from '../api/client';

interface AuthState {
  user: UserProfile | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  role: 'section_controller' | 'department' | null;
  departmentName: string | null;
  login: (email: string, password: string) => Promise<LoginResponse>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [token, setToken] = useState<string | null>(getAuthToken());
  const [isLoading, setIsLoading] = useState(true);

  // Try to restore session on mount
  useEffect(() => {
    const savedToken = getAuthToken();
    const savedUser = localStorage.getItem('railsetu_user');

    if (savedToken && savedUser) {
      try {
        const parsed = JSON.parse(savedUser) as UserProfile;
        setUser(parsed);
        setToken(savedToken);
      } catch {
        clearAuthToken();
      }
    }
    setIsLoading(false);
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<LoginResponse> => {
    const response = await apiLogin({ email, password });
    setAuthToken(response.access_token);
    setToken(response.access_token);

    // Fetch full user profile
    const profile = await getMe();
    setUser(profile);
    localStorage.setItem('railsetu_user', JSON.stringify(profile));

    return response;
  }, []);

  const logout = useCallback(() => {
    clearAuthToken();
    setToken(null);
    setUser(null);
  }, []);

  const value: AuthState = {
    user,
    token,
    isLoading,
    isAuthenticated: !!token && !!user,
    role: user?.role ?? null,
    departmentName: user?.department_name ?? null,
    login,
    logout,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
