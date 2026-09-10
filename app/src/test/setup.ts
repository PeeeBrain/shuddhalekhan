import { GlobalRegistrator } from '@happy-dom/global-registrator'

const nativeAbortController = AbortController

GlobalRegistrator.register()

Object.assign(globalThis, { __nativeAbortController: nativeAbortController })

import '@testing-library/jest-dom'
