import React from 'react';
import ReactDOM from 'react-dom/client';
import { RuntimeShellPrototype } from './RuntimeShellPrototype';
import './runtime-shell-prototype.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RuntimeShellPrototype />
  </React.StrictMode>,
);
