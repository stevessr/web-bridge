import 'package:flutter/material.dart';

import 'models/account_route.dart';
import 'services/matrix_provider.dart';
import 'services/server_gateway.dart';

void main() => runApp(const WebBridgeApp());

class WebBridgeApp extends StatelessWidget {
  const WebBridgeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'web-bridge',
      theme: ThemeData(colorSchemeSeed: Colors.blue, useMaterial3: true),
      darkTheme: ThemeData(colorSchemeSeed: Colors.blue, brightness: Brightness.dark, useMaterial3: true),
      home: const BootstrapPage(),
    );
  }
}

class BootstrapPage extends StatefulWidget {
  const BootstrapPage({super.key});

  @override
  State<BootstrapPage> createState() => _BootstrapPageState();
}

class _BootstrapPageState extends State<BootstrapPage> {
  final serverController = TextEditingController(text: 'ws://127.0.0.1:8787/v1/ws');
  final tokenController = TextEditingController(text: 'dev-client-token');
  ServerGateway? gateway;
  String status = 'Disconnected';

  Future<void> connect() async {
    final next = ServerGateway(Uri.parse(serverController.text), tokenController.text);
    await next.connect();
    setState(() {
      gateway = next;
      status = 'Server connected';
    });
  }

  @override
  Widget build(BuildContext context) {
    const routes = [
      AccountRoute(network: ChatNetwork.qq, mode: RouteMode.server),
      AccountRoute(network: ChatNetwork.matrix, mode: RouteMode.client),
      AccountRoute(network: ChatNetwork.telegram, mode: RouteMode.client),
    ];

    return Scaffold(
      appBar: AppBar(title: const Text('web-bridge v2')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          Text('Greenfield unified messenger', style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: 8),
          Text(status),
          const SizedBox(height: 24),
          TextField(controller: serverController, decoration: const InputDecoration(labelText: 'Server WebSocket URL')),
          const SizedBox(height: 12),
          TextField(controller: tokenController, obscureText: true, decoration: const InputDecoration(labelText: 'Client token')),
          const SizedBox(height: 12),
          FilledButton(onPressed: connect, child: const Text('Connect server')),
          const SizedBox(height: 28),
          ...routes.map((route) => ListTile(
                title: Text(route.network.name),
                subtitle: Text(route.mode == RouteMode.server ? 'Managed by server' : 'Managed on this device'),
                trailing: route.network == ChatNetwork.qq ? const Icon(Icons.lock_outline) : const Icon(Icons.swap_horiz),
              )),
          const Divider(),
          const Text('Matrix client mode uses the Extera-compatible Matrix Dart SDK. Telegram provider UI/runtime is the next provider milestone.'),
        ],
      ),
    );
  }
}

// Keep the import alive while the account setup UI is still minimal.
final matrixProviderFactory = MatrixProvider.new;
