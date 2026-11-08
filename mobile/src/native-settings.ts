import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { createSettingsStore } from './settings-storage';
import type { MobileSettings } from './settings';
import { requireOptionalNativeModule } from 'expo';
import { fetch } from 'expo/fetch';
import { ChatGptAuth, type ChatGptNative } from './chatgpt';

const nativeChatGpt = requireOptionalNativeModule<ChatGptNative>('ShuddhalekhanChatGpt');
const chatGptStorageKey = 'shuddhalekhan.chatgpt';
const unavailable = async (): Promise<never> => { throw new Error('ChatGPT sign-in is unavailable in this build. Install a build with the native authentication module.'); };
export const chatGptAuth = new ChatGptAuth({ fetch, now: Date.now, native: nativeChatGpt ?? {
  start: unavailable, open: unavailable, random: unavailable, challenge: unavailable, hostId: unavailable,
  cancel: async () => {},
}, storage: {
  get: () => SecureStore.getItemAsync(chatGptStorageKey),
  set: value => SecureStore.setItemAsync(chatGptStorageKey, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  remove: () => SecureStore.deleteItemAsync(chatGptStorageKey),
} });

const store = createSettingsStore({
  metadata: {
    getItem: key => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
  },
  secrets: {
    getItem: key => SecureStore.getItemAsync(key),
    setItem: (key, value) => SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
    deleteItem: key => SecureStore.deleteItemAsync(key),
  },
  createId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
});

export function loadSettings(): Promise<MobileSettings> {
  return store.loadSettings();
}

export function saveSettings(settings: MobileSettings): Promise<MobileSettings> {
  return store.saveSettings(settings);
}
