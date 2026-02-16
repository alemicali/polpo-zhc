// ignore_for_file: unnecessary_getters_setters
import '/backend/algolia/serialization_util.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

import '/backend/schema/util/firestore_util.dart';

import 'index.dart';
import '/flutter_flow/flutter_flow_util.dart';

class ServiceDataStruct extends FFFirebaseStruct {
  ServiceDataStruct({
    String? name,
    int? duration,
    double? price,
    int? staffInvolved,
    DocumentReference? serviceReference,
    List<AppointmentDataStruct>? appointmentsData,
    String? categoryName,
    FirestoreUtilData firestoreUtilData = const FirestoreUtilData(),
  })  : _name = name,
        _duration = duration,
        _price = price,
        _staffInvolved = staffInvolved,
        _serviceReference = serviceReference,
        _appointmentsData = appointmentsData,
        _categoryName = categoryName,
        super(firestoreUtilData);

  // "name" field.
  String? _name;
  String get name => _name ?? '';
  set name(String? val) => _name = val;

  bool hasName() => _name != null;

  // "duration" field.
  int? _duration;
  int get duration => _duration ?? 0;
  set duration(int? val) => _duration = val;

  void incrementDuration(int amount) => duration = duration + amount;

  bool hasDuration() => _duration != null;

  // "price" field.
  double? _price;
  double get price => _price ?? 0.0;
  set price(double? val) => _price = val;

  void incrementPrice(double amount) => price = price + amount;

  bool hasPrice() => _price != null;

  // "staffInvolved" field.
  int? _staffInvolved;
  int get staffInvolved => _staffInvolved ?? 0;
  set staffInvolved(int? val) => _staffInvolved = val;

  void incrementStaffInvolved(int amount) =>
      staffInvolved = staffInvolved + amount;

  bool hasStaffInvolved() => _staffInvolved != null;

  // "serviceReference" field.
  DocumentReference? _serviceReference;
  DocumentReference? get serviceReference => _serviceReference;
  set serviceReference(DocumentReference? val) => _serviceReference = val;

  bool hasServiceReference() => _serviceReference != null;

  // "appointmentsData" field.
  List<AppointmentDataStruct>? _appointmentsData;
  List<AppointmentDataStruct> get appointmentsData =>
      _appointmentsData ?? const [];
  set appointmentsData(List<AppointmentDataStruct>? val) =>
      _appointmentsData = val;

  void updateAppointmentsData(Function(List<AppointmentDataStruct>) updateFn) {
    updateFn(_appointmentsData ??= []);
  }

  bool hasAppointmentsData() => _appointmentsData != null;

  // "categoryName" field.
  String? _categoryName;
  String get categoryName => _categoryName ?? '';
  set categoryName(String? val) => _categoryName = val;

  bool hasCategoryName() => _categoryName != null;

  static ServiceDataStruct fromMap(Map<String, dynamic> data) =>
      ServiceDataStruct(
        name: data['name'] as String?,
        duration: castToType<int>(data['duration']),
        price: castToType<double>(data['price']),
        staffInvolved: castToType<int>(data['staffInvolved']),
        serviceReference: data['serviceReference'] as DocumentReference?,
        appointmentsData: getStructList(
          data['appointmentsData'],
          AppointmentDataStruct.fromMap,
        ),
        categoryName: data['categoryName'] as String?,
      );

  static ServiceDataStruct? maybeFromMap(dynamic data) => data is Map
      ? ServiceDataStruct.fromMap(data.cast<String, dynamic>())
      : null;

  Map<String, dynamic> toMap() => {
        'name': _name,
        'duration': _duration,
        'price': _price,
        'staffInvolved': _staffInvolved,
        'serviceReference': _serviceReference,
        'appointmentsData': _appointmentsData?.map((e) => e.toMap()).toList(),
        'categoryName': _categoryName,
      }.withoutNulls;

  @override
  Map<String, dynamic> toSerializableMap() => {
        'name': serializeParam(
          _name,
          ParamType.String,
        ),
        'duration': serializeParam(
          _duration,
          ParamType.int,
        ),
        'price': serializeParam(
          _price,
          ParamType.double,
        ),
        'staffInvolved': serializeParam(
          _staffInvolved,
          ParamType.int,
        ),
        'serviceReference': serializeParam(
          _serviceReference,
          ParamType.DocumentReference,
        ),
        'appointmentsData': serializeParam(
          _appointmentsData,
          ParamType.DataStruct,
          isList: true,
        ),
        'categoryName': serializeParam(
          _categoryName,
          ParamType.String,
        ),
      }.withoutNulls;

  static ServiceDataStruct fromSerializableMap(Map<String, dynamic> data) =>
      ServiceDataStruct(
        name: deserializeParam(
          data['name'],
          ParamType.String,
          false,
        ),
        duration: deserializeParam(
          data['duration'],
          ParamType.int,
          false,
        ),
        price: deserializeParam(
          data['price'],
          ParamType.double,
          false,
        ),
        staffInvolved: deserializeParam(
          data['staffInvolved'],
          ParamType.int,
          false,
        ),
        serviceReference: deserializeParam(
          data['serviceReference'],
          ParamType.DocumentReference,
          false,
          collectionNamePath: ['accomodationServices'],
        ),
        appointmentsData: deserializeStructParam<AppointmentDataStruct>(
          data['appointmentsData'],
          ParamType.DataStruct,
          true,
          structBuilder: AppointmentDataStruct.fromSerializableMap,
        ),
        categoryName: deserializeParam(
          data['categoryName'],
          ParamType.String,
          false,
        ),
      );

  static ServiceDataStruct fromAlgoliaData(Map<String, dynamic> data) =>
      ServiceDataStruct(
        name: convertAlgoliaParam(
          data['name'],
          ParamType.String,
          false,
        ),
        duration: convertAlgoliaParam(
          data['duration'],
          ParamType.int,
          false,
        ),
        price: convertAlgoliaParam(
          data['price'],
          ParamType.double,
          false,
        ),
        staffInvolved: convertAlgoliaParam(
          data['staffInvolved'],
          ParamType.int,
          false,
        ),
        serviceReference: convertAlgoliaParam(
          data['serviceReference'],
          ParamType.DocumentReference,
          false,
        ),
        appointmentsData: convertAlgoliaParam<AppointmentDataStruct>(
          data['appointmentsData'],
          ParamType.DataStruct,
          true,
          structBuilder: AppointmentDataStruct.fromAlgoliaData,
        ),
        categoryName: convertAlgoliaParam(
          data['categoryName'],
          ParamType.String,
          false,
        ),
        firestoreUtilData: FirestoreUtilData(
          clearUnsetFields: false,
          create: true,
        ),
      );

  @override
  String toString() => 'ServiceDataStruct(${toMap()})';

  @override
  bool operator ==(Object other) {
    const listEquality = ListEquality();
    return other is ServiceDataStruct &&
        name == other.name &&
        duration == other.duration &&
        price == other.price &&
        staffInvolved == other.staffInvolved &&
        serviceReference == other.serviceReference &&
        listEquality.equals(appointmentsData, other.appointmentsData) &&
        categoryName == other.categoryName;
  }

  @override
  int get hashCode => const ListEquality().hash([
        name,
        duration,
        price,
        staffInvolved,
        serviceReference,
        appointmentsData,
        categoryName
      ]);
}

ServiceDataStruct createServiceDataStruct({
  String? name,
  int? duration,
  double? price,
  int? staffInvolved,
  DocumentReference? serviceReference,
  String? categoryName,
  Map<String, dynamic> fieldValues = const {},
  bool clearUnsetFields = true,
  bool create = false,
  bool delete = false,
}) =>
    ServiceDataStruct(
      name: name,
      duration: duration,
      price: price,
      staffInvolved: staffInvolved,
      serviceReference: serviceReference,
      categoryName: categoryName,
      firestoreUtilData: FirestoreUtilData(
        clearUnsetFields: clearUnsetFields,
        create: create,
        delete: delete,
        fieldValues: fieldValues,
      ),
    );

ServiceDataStruct? updateServiceDataStruct(
  ServiceDataStruct? serviceData, {
  bool clearUnsetFields = true,
  bool create = false,
}) =>
    serviceData
      ?..firestoreUtilData = FirestoreUtilData(
        clearUnsetFields: clearUnsetFields,
        create: create,
      );

void addServiceDataStructData(
  Map<String, dynamic> firestoreData,
  ServiceDataStruct? serviceData,
  String fieldName, [
  bool forFieldValue = false,
]) {
  firestoreData.remove(fieldName);
  if (serviceData == null) {
    return;
  }
  if (serviceData.firestoreUtilData.delete) {
    firestoreData[fieldName] = FieldValue.delete();
    return;
  }
  final clearFields =
      !forFieldValue && serviceData.firestoreUtilData.clearUnsetFields;
  if (clearFields) {
    firestoreData[fieldName] = <String, dynamic>{};
  }
  final serviceDataData =
      getServiceDataFirestoreData(serviceData, forFieldValue);
  final nestedData =
      serviceDataData.map((k, v) => MapEntry('$fieldName.$k', v));

  final mergeFields = serviceData.firestoreUtilData.create || clearFields;
  firestoreData
      .addAll(mergeFields ? mergeNestedFields(nestedData) : nestedData);
}

Map<String, dynamic> getServiceDataFirestoreData(
  ServiceDataStruct? serviceData, [
  bool forFieldValue = false,
]) {
  if (serviceData == null) {
    return {};
  }
  final firestoreData = mapToFirestore(serviceData.toMap());

  // Add any Firestore field values
  serviceData.firestoreUtilData.fieldValues
      .forEach((k, v) => firestoreData[k] = v);

  return forFieldValue ? mergeNestedFields(firestoreData) : firestoreData;
}

List<Map<String, dynamic>> getServiceDataListFirestoreData(
  List<ServiceDataStruct>? serviceDatas,
) =>
    serviceDatas?.map((e) => getServiceDataFirestoreData(e, true)).toList() ??
    [];
