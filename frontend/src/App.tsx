// src/App.tsx — react-router routes + shell-level LoginModal (TRD §10, WIREFRAME §0/§1).
// Read-gate is optional; write actions open the login modal when no token.
import { Route, Routes } from 'react-router-dom';
import AppShell from './layout/AppShell';
import LoginModal from './components/LoginModal';
import Home from './pages/Home';
import CreatePost from './pages/CreatePost';
import Thread from './pages/Thread';
import Profile from './pages/Profile';
import Settings from './pages/Settings';

export default function App() {
  return (
    <>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Home />} />
          <Route path="/create" element={<CreatePost />} />
          <Route path="/posts/:id" element={<Thread />} />
          <Route path="/me" element={<Profile />} />
          <Route path="/me/settings" element={<Settings />} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>

      {/* Login modal mounted at shell level (WIREFRAME §1) */}
      <LoginModal />
    </>
  );
}
