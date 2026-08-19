import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Browser-test fallback while the Worker worktree is integrated independently.
export default defineConfig({ root: process.cwd(), plugins: [react()] })
