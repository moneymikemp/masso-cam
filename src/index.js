import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './renderer/App';
import { AppProvider } from './renderer/store/AppContext';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <AppProvider>
    <App />
  </AppProvider>
);
