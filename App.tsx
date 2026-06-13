import React from 'react';
import { StatusBar } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import HomeScreen from './src/screens/HomeScreen';
import ReferencePickScreen from './src/screens/ReferencePickScreen';
import ShootScreen from './src/screens/ShootScreen';
import CompareScreen from './src/screens/CompareScreen';
import type { PoseArray } from './src/types';

export type RootStackParamList = {
  Home: undefined;
  ReferencePick: undefined;
  Shoot: { referenceUri: string; referencePose: PoseArray };
  Compare: {
    referenceUri: string;
    shotUri: string;
    matchScore: number;
    fromHistory: boolean;
  };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
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
      </Stack.Navigator>
    </NavigationContainer>
  );
}
