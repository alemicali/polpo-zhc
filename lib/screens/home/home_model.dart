import '/backend/backend.dart';
import '/components/navbar/navbar_widget.dart';
import '/components/side_nav/side_nav_bar/side_nav_bar_widget.dart';
import '/components/to_collect_amount_widget.dart';
import '/components/top_nav_bar_widget.dart';
import '/flutter_flow/flutter_flow_util.dart';
import '/index.dart';
import 'home_widget.dart' show HomeWidget;
import 'package:flutter/material.dart';

class HomeModel extends FlutterFlowModel<HomeWidget> {
  ///  State fields for stateful widgets in this page.

  // Model for SideNavBar component.
  late SideNavBarModel sideNavBarModel;
  // Model for TopNavBar component.
  late TopNavBarModel topNavBarModel;
  // Model for ToCollectAmount component.
  late ToCollectAmountModel toCollectAmountModel;
  // Stores action output result for [Backend Call - Read Document] action in Row widget.
  ClientsRecord? client;
  // Model for Navbar component.
  late NavbarModel navbarModel;

  @override
  void initState(BuildContext context) {
    sideNavBarModel = createModel(context, () => SideNavBarModel());
    topNavBarModel = createModel(context, () => TopNavBarModel());
    toCollectAmountModel = createModel(context, () => ToCollectAmountModel());
    navbarModel = createModel(context, () => NavbarModel());
  }

  @override
  void dispose() {
    sideNavBarModel.dispose();
    topNavBarModel.dispose();
    toCollectAmountModel.dispose();
    navbarModel.dispose();
  }
}
