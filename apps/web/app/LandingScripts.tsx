'use client'

import { useEffect, useRef } from 'react'
import { LANDING_SCRIPTS } from './_data/landingScripts'

/**
 * Runs the v13 landing scripts after the server-rendered markup is in the DOM
 * (React does not execute <script> injected as innerHTML), then loads Paddle.js
 * so the default-payment-link (?_ptxn=...) checkout overlay still opens.
 */
export default function LandingScripts() {
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return
    ran.current = true
    for (const s of LANDING_SCRIPTS) {
      const el = document.createElement('script')
      if (s.type === 'module') el.type = 'module'
      el.text = s.code
      document.body.appendChild(el)
    }
    if (!document.getElementById('paddle-js')) {
      const p = document.createElement('script')
      p.id = 'paddle-js'
      p.src = 'https://cdn.paddle.com/paddle/v2/paddle.js'
      p.async = true
      p.onload = () => {
        try {
          const Paddle = (window as any).Paddle
          if (Paddle && typeof Paddle.Initialize === 'function') {
            Paddle.Initialize({ token: 'live_2f6c5a2fc2044c85ff7a5fdc010' })
          }
        } catch (e) {
          /* checkout simply won't open if Paddle fails to load */
        }
      }
      document.head.appendChild(p)
    }
  }, [])
  return null
}
