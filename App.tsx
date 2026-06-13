import React from 'react';
import { StatusBar } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import HomeScreen from './src/screens/HomeScreen';
import ReferencePickScreen from './src/screens/ReferencePickScreen';
import ShootScreen from './src/screens/ShootScreen';
import CompareScreen from './src/screens/CompareScreen';
import FaceVisionSpikeScreen from './src/face/FaceVisionSpikeScreen';
import type { FaceFeatures } from './src/face/types';

export type RootStackParamList = {
  Home: undefined;
  ReferencePick: undefined;
  Shoot: { referenceUri: string; referenceFeatures: FaceFeatures };
  Compare: {
    referenceUri: string;
    shotUri: string;
    matchScore: number;
    fromHistory: boolean;
  };
  // Apple Vision 스파이크 (네이티브 detectFace 검증용 임시 화면)
  FaceVisionSpike: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <NavigationContainer theme={DarkTheme}>
        <StatusBar barStyle="light-content" />
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: '#0D0D0F' },
          headerTintColor: '#FFFFFF',
          headerShadowVisible: false,
          headerTitle: '',
        }}
      >
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen name="ReferencePick" component={ReferencePickScreen} />
        <Stack.Screen
          name="Shoot"
          component={ShootScreen}
          options={{ headerTransparent: true }}
        />
        <Stack.Screen name="Compare" component={CompareScreen} />
        <Stack.Screen
          name="FaceVisionSpike"
          component={FaceVisionSpikeScreen}
          options={{ headerTransparent: true }}
        />
      </Stack.Navigator>
      </NavigationContainer>
    </GestureHandlerRootView>
  );
}
